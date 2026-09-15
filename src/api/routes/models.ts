// 国外版（chat.qwen.ai）支持的模型列表
const MODELS = [
  { id: "qwen3.7-plus", object: "model" },
  { id: "qwen3.8-max", object: "model" },
  { id: "qwen3.7-max", object: "model" },
  { id: "qwen3.6-plus", object: "model" },
  { id: "qwen3.5-plus", object: "model" },
  { id: "qwen3.5-omni-plus", object: "model" },
];

export default {
  prefix: "/v1/models",

  get: {
    "": async () => ({
      object: "list",
      data: MODELS,
    }),
  },
};