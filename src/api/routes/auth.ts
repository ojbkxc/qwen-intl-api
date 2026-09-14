import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import auth from '@/api/controllers/auth.ts';

export default {

    prefix: '/auth',

    post: {

        '/signin': async (request: Request) => {
            request
                .validate('body.email', _.isString)
                .validate('body.password', _.isString);
            const { token, expires_at } = await auth.signin(
                request.body.email,
                request.body.password
            );
            return {
                token,
                token_type: 'Bearer',
                expires_at
            }
        }

    }

}