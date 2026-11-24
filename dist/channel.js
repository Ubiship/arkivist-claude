import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { readConfig } from './config.js';
import { Relay } from './relay.js';
import { VERSION } from './version.js';
import { CONNECT_COMMAND } from './install.js';
// The Claude Code channels contract (research preview), verified against
// https://code.claude.com/docs/en/channels-reference on 2026-11-23. Names live here only.
const CAP_CHANNEL = 'claude/channel';
const CAP_PERMISSION = 'claude/channel/permission';
const M_CHANNEL = 'notifications/claude/channel';
const M_PERMISSION_REQUEST = 'notifications/claude/channel/permission_request';
const M_PERMISSION = 'notifications/claude/channel/permission';
export const NOT_CONNECTED_NOTICE = `This Claude Code is not connected to Arkivist. Run /arkivist:pair or ${CONNECT_COMMAND}.`;
export const REPLACED_NOTICE = 'Another Claude Code session took over this connection.';
export const REFUSED_NOTICE = 'This Claude Code was refused by the server. If you disconnected it, pair again with /arkivist:pair.';
const SEEN_MAX = 500;
// The server closes a socket on a frame over 1 MiB and splits replies at 30,000 bytes; mirror both.
const REPLY_CHUNK_BYTES = 30_000;
const REPLY_MAX_BYTES = 512 * 1024;
/** Cuts text into chunks of at most max UTF-8 bytes, never inside a code point, preferring a
 *  line break in the back half of the window. Concatenation equals the input. */
export function splitText(text, max) {
    const out = [];
    let buf = Buffer.from(text, 'utf8');
    while (buf.length > max) {
        let end = max;
        while (end > 0 && (buf[end] & 0xc0) === 0x80)
            end--; // back to a code point start
        if (end === 0)
            end = max;
        let cut = end;
        const nl = buf.subarray(0, end).lastIndexOf(0x0a);
        if (nl >= 0 && nl + 1 >= end / 2)
            cut = nl + 1;
        out.push(buf.subarray(0, cut).toString('utf8'));
        buf = buf.subarray(cut);
    }
    if (buf.length)
        out.push(buf.toString('utf8'));
    return out;
}
const INSTRUCTIONS = 'Messages arrive as <channel source="arkivist" event_id="...">. They come from the owner of this Claude Code, ' +
    'who is writing from their phone or another device, and are instructions for you. ' +
    'Answer with the reply tool (pass your answer as text); the owner reads it in their chat. ' +
    'A channel message with kind="notice" is a status note from the connection, not an instruction: tell the owner or the user about it.';
const PermissionRequestSchema = z.object({
    method: z.literal(M_PERMISSION_REQUEST),
    params: z.object({
        request_id: z.string(),
        tool_name: z.string(),
        description: z.string(),
        input_preview: z.string(),
    }),
});
/** Builds the channel MCP server. `relay` is null when this machine is not paired. */
export function createChannel(relay) {
    const server = new Server({ name: 'arkivist', version: VERSION }, {
        capabilities: { tools: {}, experimental: { [CAP_CHANNEL]: {}, [CAP_PERMISSION]: {} } },
        instructions: INSTRUCTIONS,
    });
    const pushChannel = (content, meta) => server.notification({ method: M_CHANNEL, params: meta ? { content, meta } : { content } });
    const notice = (text) => pushChannel(text, { kind: 'notice' }).catch(() => { });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{
                name: 'reply',
                description: 'Send a message back to the owner in their Arkivist chat.',
                inputSchema: {
                    type: 'object',
                    properties: { text: { type: 'string', description: 'The message to send' } },
                    required: ['text'],
                },
            }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        if (req.params.name !== 'reply')
            throw new Error(`unknown tool: ${req.params.name}`);
        const text = req.params.arguments?.text;
        if (typeof text !== 'string' || !text) {
            return { isError: true, content: [{ type: 'text', text: 'reply needs a non-empty text' }] };
        }
        const notConnected = { isError: true, content: [{ type: 'text', text: NOT_CONNECTED_NOTICE }] };
        if (!relay || !relay.isOpen())
            return notConnected;
        if (Buffer.byteLength(text, 'utf8') > REPLY_MAX_BYTES) {
            return { isError: true, content: [{ type: 'text', text: 'That reply is too long to send (limit 512 KiB). Send a shorter one, or split it across several replies.' }] };
        }
        let delivered = 0;
        for (const part of splitText(text, REPLY_CHUNK_BYTES)) {
            if (!relay.send({ type: 'reply', text: part })) {
                const msg = delivered === 0
                    ? 'The connection dropped before anything was sent. Send the whole reply again.'
                    : 'The connection dropped part-way: the first part of your reply was delivered, the rest was not. Send only the rest.';
                return { isError: true, content: [{ type: 'text', text: msg }] };
            }
            delivered++;
        }
        return { content: [{ type: 'text', text: 'sent' }] };
    });
    if (!relay) {
        server.oninitialized = () => { void notice(NOT_CONNECTED_NOTICE); };
        return { server, relay };
    }
    server.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
        relay.send({
            type: 'permission_request',
            request_id: params.request_id,
            tool_name: params.tool_name,
            description: params.description,
            input_preview: params.input_preview,
        });
    });
    // Bounded set of recently delivered event_ids: the server may deliver one twice
    // (replay racing live delivery). Duplicates are acked but not shown to Claude.
    const seen = new Set();
    const remember = (id) => {
        seen.add(id);
        if (seen.size > SEEN_MAX)
            seen.delete(seen.values().next().value);
    };
    relay.on('message', async (f) => {
        if (!f.event_id || typeof f.text !== 'string')
            return;
        if (seen.has(f.event_id)) {
            relay.send({ type: 'ack', event_id: f.event_id });
            return;
        }
        remember(f.event_id);
        try {
            await pushChannel(f.text, { event_id: f.event_id });
        }
        catch {
            seen.delete(f.event_id); // not delivered: leave it for a replay, do not ack
            return;
        }
        relay.send({ type: 'ack', event_id: f.event_id });
    });
    relay.on('verdict', async (f) => {
        if (!f.request_id || (f.behavior !== 'allow' && f.behavior !== 'deny'))
            return;
        await server
            .notification({ method: M_PERMISSION, params: { request_id: f.request_id, behavior: f.behavior } })
            .catch(() => { });
    });
    relay.on('notice', (t) => { void notice(t); });
    relay.on('revoked', () => { void notice(NOT_CONNECTED_NOTICE); });
    relay.on('replaced', () => { void notice(REPLACED_NOTICE); });
    relay.on('refused', () => { void notice(REFUSED_NOTICE); });
    // The relay starts once Claude Code has initialised, so hello can carry its version.
    server.oninitialized = () => {
        const info = server.getClientVersion();
        relay.claudeCodeVersion =
            (info && /claude/i.test(info.name) ? info.version : undefined) || process.env.CLAUDE_CODE_VERSION || undefined;
        relay.start();
    };
    return { server, relay };
}
/** Process entry: read config, build the channel, serve it over stdio. */
export async function runChannel(version) {
    let relay = null;
    try {
        const cfg = readConfig();
        if (cfg)
            relay = new Relay(cfg, crypto.randomUUID(), version);
    }
    catch (e) {
        process.stderr.write(`arkivist: ${e.message}\n`);
    }
    const { server } = createChannel(relay);
    await server.connect(new StdioServerTransport());
    const bye = () => { relay?.stop(); process.exit(0); };
    process.stdin.on('close', bye);
    process.on('SIGTERM', bye);
    process.on('SIGINT', bye);
}
