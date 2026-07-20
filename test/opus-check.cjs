const { createRequire } = require("node:module");
const path = require("node:path");
const req = createRequire(__filename);
const bedrock = req(path.join(process.cwd(), "out-server/main/proxy/bedrock.js"));
const cfg = { enabled:true, accessKeyId:process.env.AWS_ACCESS_KEY_ID, secretAccessKey:process.env.AWS_SECRET_ACCESS_KEY, region:process.env.AWS_REGION||"us-east-1" };
(async () => {
  const models = await bedrock.listBedrockModels(cfg);
  const anth = models.filter(m => /anthropic|claude/i.test(m.id));
  console.log("Anthropic/Claude models:", anth.length);
  for (const m of anth) console.log(" -", m.id);
})().catch(e=>{console.error(e);process.exit(1);});
