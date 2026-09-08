/* Verify findOrCreateDirectConversation dedupes under parallel creation. */
import { findOrCreateDirectConversation } from "../src/lib/conversations";
import { prisma } from "../src/lib/prisma";

async function main() {
  await prisma.message.deleteMany();
  await prisma.conversationMember.deleteMany();
  await prisma.conversation.deleteMany();
  const [a, b] = await prisma.user.findMany({
    where: { email: { in: ["alice@example.com", "bob@example.com"] } },
  });

  // 10 parallel "start chat" clicks from both sides
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0 ? findOrCreateDirectConversation(a.id, b.id) : findOrCreateDirectConversation(b.id, a.id)
    )
  );
  const distinct = new Set(results.map((c) => c.id));
  const dmCount = await prisma.conversation.count({ where: { type: "DIRECT" } });
  console.log(`10 parallel calls → distinct conversations: ${distinct.size}, DIRECT rows: ${dmCount}`);
  if (distinct.size !== 1 || dmCount !== 1) {
    console.error("❌ DEDUPE FAILED");
    process.exit(1);
  }
  console.log("✅ advisory-lock dedupe holds");
  await prisma.$disconnect();
}
main();
