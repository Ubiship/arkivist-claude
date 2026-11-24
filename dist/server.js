#!/usr/bin/env node
import { runChannel } from './channel.js';
import { VERSION } from './version.js';
await runChannel(VERSION);
