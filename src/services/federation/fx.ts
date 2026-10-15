import { prisma } from "../../lib/prisma.js";

export async function setRate(
  federationId: string,
  baseCurrency: string,
  quoteCurrency: string,
  rate: number,
  setBy: string,
): Promise<void> {
  if (!(rate > 0)) throw new Error("INVALID_FX_RATE");
  await prisma.fxRate.create({
    data: { federationId, baseCurrency, quoteCurrency, rate, setBy },
  });
}

export async function getRate(
  federationId: string,
  from: string,
  to: string,
): Promise<number> {
  if (from === to) return 1;
  const direct = await prisma.fxRate.findFirst({
    where: { federationId, baseCurrency: from, quoteCurrency: to },
    orderBy: { effectiveAt: "desc" },
  });
  if (direct) return direct.rate;
  const inverse = await prisma.fxRate.findFirst({
    where: { federationId, baseCurrency: to, quoteCurrency: from },
    orderBy: { effectiveAt: "desc" },
  });
  if (inverse && inverse.rate > 0) return 1 / inverse.rate;
  throw new Error("NO_FX_RATE");
}
