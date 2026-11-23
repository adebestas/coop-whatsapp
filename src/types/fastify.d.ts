import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    /** Raw request body text, retained for webhook signature verification. */
    rawBody?: string;
  }
}
