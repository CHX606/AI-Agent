import Fastify, { type FastifyInstance } from "fastify";

export interface BuildAppOptions {
    logger?: boolean;
}

export function buildApp(
    options: BuildAppOptions = {},
): FastifyInstance {
    const app = Fastify({
        logger: options.logger ?? true,
    });

    app.get("/health", async () => {
        return {
            status: "ok",
            service: "repopilot-gateway",
            version: "0.1.0",
        };
    });

    return app;
}