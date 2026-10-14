import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../tests/setup.js";
import { getQuizQuestions, QUIZ_QUESTIONS } from "../src/services/literacy.js";
import {
  generateReferenceCode,
  issueCertificate,
  renderCertificatePdf,
} from "../src/services/literacy-certificate.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { handleMessage } from "../src/services/conversation.js";
import { sendDocument as sendWhatsAppDocument } from "../src/lib/whatsapp.js";

describe("literacy quiz selection", () => {
  it("returns the requested number of questions", () => {
    const qs = getQuizQuestions(6);
    expect(qs).toHaveLength(6);
  });

  it("returns unique question ids", () => {
    const qs = getQuizQuestions(6);
    const ids = qs.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is deterministic for the same seed", () => {
    const a = getQuizQuestions(6, "seed-1");
    const b = getQuizQuestions(6, "seed-1");
    expect(a.map((q) => q.id)).toEqual(b.map((q) => q.id));
  });

  it("varies with a different seed", () => {
    const a = getQuizQuestions(6, "seed-1");
    const b = getQuizQuestions(6, "seed-2");
    expect(a.map((q) => q.id)).not.toEqual(b.map((q) => q.id));
  });

  it("caps at the available question bank size", () => {
    const qs = getQuizQuestions(999);
    expect(qs.length).toBeLessThanOrEqual(QUIZ_QUESTIONS.length);
  });
});

describe("certificate reference codes", () => {
  it("prefixes with the coop code and a high-entropy suffix", () => {
    const code = generateReferenceCode("LAG01");
    expect(code).toMatch(/^CERT-LAG01-[A-Z2-9]{10}$/);
  });

  it("produces unique codes", () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateReferenceCode("LAG01")));
    expect(codes.size).toBe(50);
  });
});

describe("certificate PDF rendering", () => {
  it("renders a PDF buffer with the member name and reference code", async () => {
    const buf = await renderCertificatePdf(
      {
        referenceCode: "CERT-LAG01-7F3K9Q2X4M",
        score: 5,
        totalQuestions: 6,
        issuedAt: new Date("2026-10-10T00:00:00Z"),
      },
      { name: "Ada Obi", code: "A1B2C3" },
      { displayName: "Lagos Test Coop" },
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

async function makeCoop(code: string) {
  return prisma.cooperative.create({ data: { name: `Coop ${code}`, code } });
}

async function makeMember(coopId: string, phone: string) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) {
    code = generateMemberCode();
  }
  return prisma.member.create({
    data: {
      code,
      phone,
      name: `Member ${phone.slice(-4)}`,
      cooperativeId: coopId,
      pin: hashPin("1234"),
      wallet: { create: {} },
      consentAt: new Date(),
    },
  });
}

describe("certificate issuance", () => {
  beforeEach(async () => {
    await prisma.literacyCertificate.deleteMany();
    await prisma.member.deleteMany();
    await prisma.cooperative.deleteMany();
  });

  it("issues a certificate with a unique reference code", async () => {
    const coop = await makeCoop("LAG01");
    const member = await makeMember(coop.id, "2348011110001");
    const cert = await issueCertificate({
      memberId: member.id,
      cooperativeId: coop.id,
      score: 5,
      totalQuestions: 6,
      actorPhone: member.phone,
    });
    expect(cert.referenceCode).toMatch(/^CERT-COOP-[A-Z2-9]{10}$/);
    expect(cert.score).toBe(5);
    expect(cert.revokedAt).toBeNull();
  });

  it("re-issuing keeps the same reference code and updates the score", async () => {
    const coop = await makeCoop("LAG02");
    const member = await makeMember(coop.id, "2348011110002");
    const first = await issueCertificate({
      memberId: member.id,
      cooperativeId: coop.id,
      score: 4,
      totalQuestions: 6,
      actorPhone: member.phone,
    });
    const second = await issueCertificate({
      memberId: member.id,
      cooperativeId: coop.id,
      score: 6,
      totalQuestions: 6,
      actorPhone: member.phone,
    });
    expect(second.referenceCode).toBe(first.referenceCode);
    expect(second.score).toBe(6);
    const count = await prisma.literacyCertificate.count({ where: { memberId: member.id } });
    expect(count).toBe(1);
  });
});

/** Answer every quiz question, correctly or incorrectly, until the quiz ends. */
async function answerQuiz(phone: string, correct: boolean): Promise<void> {
  let session = await prisma.session.findUnique({ where: { phone } });
  let guard = 0;
  while (session?.state === "literacy_quiz" && guard++ < 30) {
    const data = JSON.parse(session.data);
    const quiz = data.quiz as { questionIds: number[]; index: number };
    const q = QUIZ_QUESTIONS.find((x) => x.id === quiz.questionIds[quiz.index]);
    if (!q) break;
    const letters = ["A", "B", "C", "D"];
    const answer = correct
      ? letters[q.answerIndex]
      : letters[(q.answerIndex + 1) % q.options.length];
    await handleMessage(phone, answer);
    session = await prisma.session.findUnique({ where: { phone } });
  }
}

describe("quiz flow", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await prisma.literacyCertificate.deleteMany();
    await prisma.memberProgress.deleteMany();
    await prisma.session.deleteMany();
    await prisma.member.deleteMany();
    await prisma.cooperative.deleteMany();
  });

  async function enrolledMember(code: string, phone: string) {
    const coop = await makeCoop(code);
    const member = await makeMember(coop.id, phone);
    await prisma.memberProgress.create({
      data: {
        memberId: member.id,
        certificationOptIn: true,
        completedLessons: JSON.stringify([1, 2, 3, 4, 5, 6]),
        completedAt: new Date(),
        currentLesson: 7,
      },
    });
    return member;
  }

  it("passes the quiz, issues a certificate, and sends the PDF", async () => {
    const member = await enrolledMember("QUIZ1", "2348012220001");

    await handleMessage(member.phone, "class quiz");
    const session = await prisma.session.findUnique({ where: { phone: member.phone } });
    expect(session?.state).toBe("literacy_quiz");

    await answerQuiz(member.phone, true);

    const cert = await prisma.literacyCertificate.findUnique({ where: { memberId: member.id } });
    expect(cert).toBeTruthy();
    expect(cert!.score).toBeGreaterThanOrEqual(4);
    expect(vi.mocked(sendWhatsAppDocument)).toHaveBeenCalled();

    const progress = await prisma.memberProgress.findUnique({ where: { memberId: member.id } });
    expect(progress!.quizAttempts).toBe(1);
    expect(progress!.quizPassedAt).toBeTruthy();
  });

  it("fails the quiz without issuing a certificate", async () => {
    const member = await enrolledMember("QUIZ2", "2348012220002");

    await handleMessage(member.phone, "class quiz");
    await answerQuiz(member.phone, false);

    const cert = await prisma.literacyCertificate.findUnique({ where: { memberId: member.id } });
    expect(cert).toBeNull();
    const progress = await prisma.memberProgress.findUnique({ where: { memberId: member.id } });
    expect(progress!.quizAttempts).toBe(1);
    expect(progress!.quizPassedAt).toBeNull();
  });

  it("re-prompts on invalid input without advancing", async () => {
    const member = await enrolledMember("QUIZ3", "2348012220003");

    await handleMessage(member.phone, "class quiz");
    const before = await prisma.session.findUnique({ where: { phone: member.phone } });
    const beforeData = JSON.parse(before!.data);
    await handleMessage(member.phone, "banana");
    const after = await prisma.session.findUnique({ where: { phone: member.phone } });
    const afterData = JSON.parse(after!.data);
    expect(after!.state).toBe("literacy_quiz");
    expect(afterData.quiz.index).toBe(beforeData.quiz.index);
  });

  it("guides a member who has not opted in", async () => {
    const coop = await makeCoop("QUIZ4");
    const member = await makeMember(coop.id, "2348012220004");
    await prisma.memberProgress.create({
      data: {
        memberId: member.id,
        certificationOptIn: false,
        completedLessons: JSON.stringify([1, 2, 3, 4, 5, 6]),
        completedAt: new Date(),
        currentLesson: 7,
      },
    });
    await handleMessage(member.phone, "class quiz");
    const session = await prisma.session.findUnique({ where: { phone: member.phone } });
    expect(session?.state).not.toBe("literacy_quiz");
  });
});