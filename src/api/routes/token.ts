import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import auth from '@/api/controllers/auth.ts';

export default {

    prefix: '/token',

    post: {

        '/check': async (request: Request) => {
            request
                .validate('body.token', _.isString)
            const live = await auth.checkToken(request.body.token);
            return {
                live
            }
        }

    }

}