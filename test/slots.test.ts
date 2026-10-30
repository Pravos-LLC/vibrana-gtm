import test from "node:test";
import assert from "node:assert/strict";
import { suggestSlot } from "../lib/slots";
import { composePdf } from "../lib/publish-item";

const TZ = "Europe/Berlin";

test("LinkedIn lands on the next weekday morning, Instagram and YouTube may take Saturday", () => {
  const saturday = new Date("2026-10-03T15:00:00Z"); // Sat 17:00 Berlin
  assert.deepEqual(suggestSlot("linkedin", saturday, TZ), { date: "2026-10-05", time: "08:30" });
  assert.deepEqual(suggestSlot("instagram", saturday, TZ), { date: "2026-10-03", time: "18:00" });
  assert.deepEqual(suggestSlot("youtube", saturday, TZ), { date: "2026-10-05", time: "17:00" });
});

test("Instagram rolls past Sunday (off) when tonight's slot is under 30 minutes away", () => {
  assert.deepEqual(suggestSlot("instagram", new Date("2026-10-03T15:40:00Z"), TZ), { date: "2026-10-05", time: "18:00" });
});

test("composePdf makes one page per image at the image's own size", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64"); // 1x1 PNG
  const pdf = await composePdf([png, png, png], [".png", ".png", ".png"]);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(pdf);
  assert.equal(doc.getPageCount(), 3);
  assert.deepEqual([doc.getPage(0).getWidth(), doc.getPage(0).getHeight()], [1, 1]);
});
