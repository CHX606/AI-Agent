import { buildApp } from "./app.js";

const app = buildApp();

const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

try {
  const address = await app.listen({ host, port });
  app.log.info({ address }, "RepoPilot Gateway started");
} catch (error) {
  app.log.error(error);
  process.exit(1);
}