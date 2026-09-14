import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";

export default {
  prefix: "/v1/images",

  post: {
    "/generations": async (request: Request) => {
      request
        .validate("body.prompt", _.isString)
        .validate("headers.authorization", _.isString);
      // 国外版绘图接口同样受风控保护，暂未实现
      throw new APIException(
        EX.API_IMAGE_GENERATION_FAILED,
        "国外版绘图接口暂未实现，敬请期待"
      );
    },
  },
};