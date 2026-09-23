import { supabase } from "./supabase.js";

const rawWallets = [
  "6HJetMbdHBuk3mLUainxAPpBpWzDgYbHGTS2TqDAUSX2",
  "HDjrSeWBNgASbs5aviTrXy6s7Pytx173vWpJZ43MPV8t",
  "5CEbueQnq1Ym2uSSx2xXds3jQAqT1BDnkA59RZobSPAG",
  "BAo2bfUVNLqnMrPinZiqVVwoWu2eXDYXRFxVTjKtdjkH",
  "DFVFmrQT6SKQQeFykFfa3DGqVACjLgVbSH1XKypYFVFL",
  "DeNCjD7HGs7upaPeJ9t395nCrWLZNzxZuXho7NJaGzch",
  "8XAyuENgqkxb2cU5Mk7x2AxgHbnGmdsKej1qjTJCcDcP",
  "3cBB2ZyoNy8YEquSSzR2Rpggp9vcrfz4NcbCKHp7BzvT",
  "8vKEy5XeZE5iEB9QCpypKSWQ75dxk1qfYDn5Zf83TNdx",
  "GZetT3iRmhuzuT1gkSk69MXMe8hRJZJGz1PPdKW1J2vq",
  "DeLNUz4qCK8qsnBZn6uCKfnuVTjNug9nbMN8k9nhbhx7",
  "CM1dn5LZ21o6PQv3NQpQeEFPGGo9dNpSQ4eWQctmp17g",
  "Eo4UgT1XFuHqF9GbbG2oENn7GtHPux2xnXKQPoVLdhzM",
  "89HbgWduLwoxcofWpmn1EiF9wEdpgkNDEyPjzZ72mkDi",
  "888888MDzTt1Ebxhf9EHECM1VRUVFA2538oKmU5HdcuW"
];

async function seed() {
  const uniqueWallets = Array.from(new Set(rawWallets));
  console.log(`Inserting ${uniqueWallets.length} unique wallets...`);

  const rows = uniqueWallets.map((address) => ({ address, source: "seed" }));
  const { error } = await supabase.from("tracked_wallets").upsert(rows, { onConflict: "address" });

  if (error) {
    console.error("Error inserting wallets:", error);
    process.exit(1);
  }

  const { count } = await supabase.from("tracked_wallets").select("*", { count: "exact", head: true });
  console.log(`Successfully seeded! Total tracked wallets in DB: ${count}`);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
