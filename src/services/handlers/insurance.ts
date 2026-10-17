import { sendText } from "../../lib/messaging.js";
import { config } from "../../config.js";
import { prisma } from "../../lib/prisma.js";
import { getMemberByPhone } from "../cooperative.js";
import { InsuranceService } from "../insurance/index.js";
import { CubeCoverClient } from "../insurance/cubecover.js";

/**
 * Build a CubeCover-backed insurance service from config. Endpoints/credentials
 * are inferred until CubeCover's real developer docs are available — see
 * config.cubecover for the env vars.
 */
export function insuranceService(): InsuranceService {
  return new InsuranceService({
    prisma,
    cubecover: new CubeCoverClient({
      apiKey: config.cubecover.apiKey,
      baseUrl: config.cubecover.baseUrl,
      webhookSecret: config.cubecover.webhookSecret,
    }),
  });
}

/**
 * Telemedicine handoff ("doctor" command).
 *
 * CubeCover delivers live doctor consultations through its OWN app/portal — no
 * consultation API is exposed in the integration — so the member is deep-linked
 * OUT to CubeCover to start a consult. If CubeCover later documents a
 * telemedicine API, replace the link below with an in-app consult flow.
 */
export async function handleDoctor(phone: string): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({
      to: phone,
      text: "You need to join a cooperative first. Reply *join <code>* to get started.",
    });
    return;
  }

  const url = config.cubecover.telemedicineUrl;
  await sendText({
    to: phone,
    text:
      "🏥 *Talk to a doctor*\n\n" +
      "Your SuperCare cover includes 24/7 access to licensed doctors. " +
      "Consultations are handled in the CubeCover app — tap the link below to open it:\n\n" +
      `${url}\n\n` +
      "Typical wait time is 2–10 minutes. No internet? Dial *3013#.\n\n" +
      "Reply *menu* to return to other options.",
  });
}

/**
 * "insurance" command — browse the CubeCover product catalogue and start the
 * in-app purchase flow (product → plan → confirm). Everything stays in-chat:
 * quotes and policy creation happen server-side via the CubeCover API.
 */
export async function handleInsurance(phone: string): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({
      to: phone,
      text: "You need to join a cooperative first. Reply *join <code>* to get started.",
    });
    return;
  }

  let products;
  try {
    products = await insuranceService().getProducts();
  } catch {
    await sendText({
      to: phone,
      text: "Insurance is temporarily unavailable right now. Please try again later. Reply *menu* to return.",
    });
    return;
  }

  if (!products.length) {
    await sendText({
      to: phone,
      text: "No insurance products are available right now. Reply *menu* to return.",
    });
    return;
  }

  const lines = products.map((p) => `• *${p.code}* — ${p.name}: ${p.description}`).join("\n");
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "awaiting_insurance_product", data: "{}" },
    update: { state: "awaiting_insurance_product", data: "{}" },
  });
  await sendText({
    to: phone,
    text:
      `🏥 *Insurance products*\n\n${lines}\n\n` +
      `Reply with a product code (e.g. *${products[0].code}*) to see its plans, or *menu* to cancel.`,
  });
}
