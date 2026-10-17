import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { renderCertificatePdf } from "../services/literacy-certificate.js";

/**
 * Public certificate verification. Intentionally unauthenticated so a member can
 * share proof and a third party can verify it. The reference code is
 * high-entropy, so the endpoint exposes nothing but the certificate PDF itself.
 * Rate-limited to discourage enumeration.
 */
export const certificateRoutes = (app: FastifyInstance): void => {
  app.get(
    "/api/certificate/:code",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { code } = req.params as { code: string };
      if (!code || code.length < 6) {
        return reply.code(404).send({ error: "Not found" });
      }

      // Accept either the full reference code or its high-entropy suffix.
      const cert = await prisma.literacyCertificate.findFirst({
        where: {
          revokedAt: null,
          OR: [{ referenceCode: code }, { referenceCode: { endsWith: code } }],
        },
        include: { member: true, cooperative: true },
      });
      if (!cert) {
        return reply.code(404).send({ error: "Not found" });
      }

      const pdf = await renderCertificatePdf(
        {
          referenceCode: cert.referenceCode,
          score: cert.score,
          totalQuestions: cert.totalQuestions,
          issuedAt: cert.issuedAt,
        },
        { name: cert.member.name, code: cert.member.code },
        { displayName: cert.cooperative.name },
      );

      return reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `inline; filename="${cert.referenceCode}.pdf"`)
        .send(pdf);
    },
  );
};
