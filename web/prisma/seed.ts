/* eslint-disable no-console */
import { PrismaClient, Prisma, ConversationType } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const PASSWORD = "Password123!";
const minutes = (n: number) => new Date(Date.now() - n * 60_000);

async function main() {
  console.log("🌱 Seeding…");
  await prisma.message.deleteMany();
  await prisma.conversationMember.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.user.deleteMany();

  const hash = await bcrypt.hash(PASSWORD, 10);

  const users = await Promise.all(
    (
      [
        ["alice@example.com", "Alice Chen", "Product designer. Coffee enthusiast ☕"],
        ["bob@example.com", "Bob Martins", "Backend engineer. Redis apologist."],
        ["carol@example.com", "Carol Nkemdirim", "Frontend dev & UI animation nerd"],
        ["dave@example.com", "Dave Okafor", "DevOps. If it moves, containerize it."],
        ["erin@example.com", "Erin Volkova", "QA lead. Breaking builds since 2015."],
        ["frank@example.com", "Frank Duarte", "Engineering manager. Slack power user."],
      ] as const
    ).map(([email, name, bio]) =>
      prisma.user.create({ data: { email, name, bio, passwordHash: hash } })
    )
  );
  const [alice, bob, carol, dave, erin, frank] = users;
  console.log(`  users: ${users.length}`);

  async function createConversation(
    type: ConversationType,
    name: string | null,
    ownerId: string,
    memberIds: string[],
    lastMessageAt: Date
  ) {
    return prisma.conversation.create({
      data: {
        type,
        name,
        createdById: ownerId,
        lastMessageAt,
        members: {
          create: memberIds.map((userId, i) => ({
            userId,
            role: userId === ownerId && type === "GROUP" ? "OWNER" : "MEMBER",
            // stagger watermarks so some members have unread messages
            lastReadAt: minutes(10 + i * 30),
          })),
        },
      },
    });
  }

  async function addMessage(
    conversationId: string,
    data: Omit<Prisma.MessageUncheckedCreateInput, "conversationId">,
    createdAt: Date
  ) {
    return prisma.message.create({ data: { ...data, conversationId, createdAt } });
  }

  // ---------- DM: Alice ↔ Bob ----------
  const dmAb = await createConversation("DIRECT", null, alice.id, [alice.id, bob.id], minutes(5));

  await addMessage(dmAb.id, { senderId: alice.id, type: "TEXT", body: "Hey Bob! Did you see the deploy went out clean?" }, minutes(240));
  await addMessage(dmAb.id, { senderId: bob.id, type: "TEXT", body: "Yep — zero rollbacks for once 🎉" }, minutes(232));
  await addMessage(dmAb.id, { senderId: bob.id, type: "TEXT", body: "The **redis adapter** is the last piece before we can demo two instances" }, minutes(230));
  const ab4 = await addMessage(dmAb.id, { senderId: alice.id, type: "TEXT", body: "nice. how's the rate limiter coming along?" }, minutes(28));
  await addMessage(dmAb.id, { senderId: bob.id, type: "TEXT", body: "30 msgs / 10s per user, acks 429 over the limit. Fixed window on `INCR`", replyToId: ab4.id }, minutes(22));
  // edit + soft delete samples
  await addMessage(dmAb.id, { senderId: alice.id, type: "TEXT", body: "Perfect. Ship it Friday", editedAt: minutes(18) }, minutes(20));
  await addMessage(dmAb.id, { senderId: bob.id, type: "TEXT", body: "typo message that got deleted", deletedAt: minutes(15) }, minutes(16));

  // ---------- DM: Carol ↔ Dave ----------
  const dmCd = await createConversation("DIRECT", null, carol.id, [carol.id, dave.id], minutes(90));
  await addMessage(dmCd.id, { senderId: carol.id, type: "TEXT", body: "Dave, the compose file needs the redis healthcheck" }, minutes(120));
  await addMessage(dmCd.id, { senderId: dave.id, type: "TEXT", body: "already on main — `test: redis-cli ping`" }, minutes(100));
  await addMessage(dmCd.id, { senderId: carol.id, type: "TEXT", body: "Legend. 🙏" }, minutes(95));

  // ---------- Group: "Design Sync" (owner Alice) ----------
  const g1 = await createConversation("GROUP", "Design Sync", alice.id, [alice.id, bob.id, carol.id], minutes(50));
  await addMessage(g1.id, { senderId: null, type: "SYSTEM", body: "Alice Chen created the group “Design Sync”" }, minutes(300));
  await addMessage(g1.id, { senderId: null, type: "SYSTEM", body: "Alice Chen added Bob Martins" }, minutes(295));
  await addMessage(g1.id, { senderId: alice.id, type: "TEXT", body: "Welcome! Dropping the Figma link in a sec" }, minutes(200));
  const g1r = await addMessage(g1.id, { senderId: carol.id, type: "TEXT", body: "Can we move this to 3pm? Conflict with standup" }, minutes(60));
  await addMessage(g1.id, { senderId: bob.id, type: "TEXT", body: "+1 works for me", replyToId: g1r.id }, minutes(55));

  // ---------- Group: "All Hands" (owner Frank, everyone) ----------
  const g2 = await createConversation(
    "GROUP",
    "All Hands",
    frank.id,
    users.map((u) => u.id),
    minutes(2)
  );
  await addMessage(g2.id, { senderId: null, type: "SYSTEM", body: "Frank Duarte created the group “All Hands”" }, minutes(1440));
  await addMessage(g2.id, { senderId: frank.id, type: "TEXT", body: "Quarterly all-hands Friday 10am. Agenda in the doc." }, minutes(144));
  await addMessage(g2.id, { senderId: erin.id, type: "TEXT", body: "Will the recording be shared after?" }, minutes(140));
  await addMessage(g2.id, { senderId: frank.id, type: "TEXT", body: "Yes — link lands in this channel ~1h after." }, minutes(138));
  await addMessage(g2.id, { senderId: dave.id, type: "IMAGE", body: "New office mural 🎨", attachmentKey: `${dave.id}/seed-mural.jpg`, attachmentName: "mural.jpg", attachmentSize: 238_400, attachmentMime: "image/jpeg", attachmentWidth: 1200, attachmentHeight: 800 }, minutes(30));
  await addMessage(g2.id, { senderId: alice.id, type: "TEXT", body: "Whoa, that's gorgeous" }, minutes(8));
  await addMessage(g2.id, { senderId: frank.id, type: "TEXT", body: "See you all Friday!" }, minutes(2));

  console.log("  conversations: 4 (2 DMs, 2 groups)");
  console.log(`  messages: ${await prisma.message.count()}`);
  console.log("\n✅ Seed complete. Sign in with any of:");
  for (const u of users) console.log(`   ${u.email} / ${PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
