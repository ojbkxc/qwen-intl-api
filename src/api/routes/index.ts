import fs from 'fs-extra';

import Response from '@/lib/response/Response.ts';
import auth from "./auth.ts";
import chat from "./chat.ts";
import images from "./images.ts";
import models from "./models.ts";
import ping from "./ping.ts";
import pool from './pool.ts';
import token from './token.ts';

export default [
    {
        get: {
            '/': async () => {
                const content = await fs.readFile('public/welcome.html');
                return new Response(content, {
                    type: 'html',
                    headers: {
                        Expires: '-1'
                    }
                });
            },
            '/pool/ui': async () => {
                const content = await fs.readFile('public/pool.html');
                return new Response(content, {
                    type: 'html',
                    headers: {
                        Expires: '-1'
                    }
                });
            }
        }
    },
    auth,
    chat,
    images,
    models,
    ping,
    pool,
    token
];