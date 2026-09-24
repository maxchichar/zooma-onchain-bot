import fs from "fs";
import path from "path";

export interface RegisteredUser {
  userId: string;
  chatId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  isRegistered: boolean;
  registeredAt: string;
  lastActiveAt: string;
  commandCount: number;
  role: "admin" | "user";
  status: "active" | "suspended";
  memberNumber: number;
}

export interface UserStats {
  totalUsers: number;
  active24h: number;
  active7d: number;
  totalCommands: number;
  recentUsers: RegisteredUser[];
}

const REGISTERED_USERS_FILE = path.resolve(process.cwd(), ".registered_users.json");
const ACTIVE_CHATS_FILE = path.resolve(process.cwd(), ".active_chats.json");

const usersMap = new Map<string, RegisteredUser>();
let nextMemberNumber = 1;

function isIdAdmin(id: string): boolean {
  const strId = String(id);
  if (strId === "8653623689") return false;
  const envAdmin = process.env.TELEGRAM_CHAT_ID;
  const explicitAdmin = process.env.ADMIN_USER_ID;
  const adminIds = process.env.ADMIN_USER_IDS
    ? process.env.ADMIN_USER_IDS.split(",").map((s) => s.trim())
    : [];
  return Boolean(
    (explicitAdmin && explicitAdmin === strId) ||
    adminIds.includes(strId) ||
    (envAdmin && envAdmin !== "8653623689" && envAdmin === strId)
  );
}

/**
 * Checks whether a user has administrator privileges.
 * Automatically identifies the owner (first human user) as administrator.
 */
export function isUserAdmin(userId: string): boolean {
  if (!userId) return false;
  const id = String(userId);
  if (id === "8653623689" || id.startsWith("-")) return false;

  const user = usersMap.get(id);
  if (user && user.role === "admin") return true;

  if (isIdAdmin(id)) {
    if (user && user.role !== "admin") {
      user.role = "admin";
      saveUsers();
    }
    return true;
  }

  // Count human administrators currently registered
  const humanAdmins = Array.from(usersMap.values()).filter(
    (u) => u.userId !== "8653623689" && !u.userId.startsWith("-") && u.role === "admin"
  );

  // If no human admin exists in the system yet:
  // Automatically identify this user as the Bot Owner & Administrator!
  if (humanAdmins.length === 0) {
    if (user) {
      user.role = "admin";
      saveUsers();
      console.log(`[userRegistry] automatically identified user ${id} as Bot Owner & Administrator`);
    }
    return true;
  }

  return false;
}

/**
 * Grants administrator privileges to a user.
 */
export function makeUserAdmin(userId: string): boolean {
  const user = usersMap.get(String(userId));
  if (user) {
    user.role = "admin";
    saveUsers();
    return true;
  }
  return false;
}

function loadUsers(): void {
  try {
    if (fs.existsSync(REGISTERED_USERS_FILE)) {
      const data = JSON.parse(fs.readFileSync(REGISTERED_USERS_FILE, "utf8"));
      if (Array.isArray(data)) {
        for (const u of data) {
          if (u && u.userId && u.userId !== "8653623689" && !String(u.userId).startsWith("-")) {
            usersMap.set(String(u.userId), u);
            if (typeof u.memberNumber === "number" && u.memberNumber >= nextMemberNumber) {
              nextMemberNumber = u.memberNumber + 1;
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn("[userRegistry] failed to read registered users file:", (err as Error).message);
  }

  // If any human user was registered but no human admin is marked yet,
  // automatically promote Member #1 or the earliest user to Administrator
  const humanUsers = Array.from(usersMap.values()).filter(
    (u) => u.userId !== "8653623689" && !u.userId.startsWith("-")
  );
  const humanAdmins = humanUsers.filter((u) => u.role === "admin");
  if (humanUsers.length > 0 && humanAdmins.length === 0) {
    const earliest = humanUsers.sort((a, b) => a.memberNumber - b.memberNumber)[0];
    earliest.role = "admin";
    console.log(`[userRegistry] automatically promoted Member #${earliest.memberNumber} (${earliest.userId}) to Administrator`);
  }

  saveUsers();
}

function saveUsers(): void {
  try {
    const list = Array.from(usersMap.values());
    fs.writeFileSync(REGISTERED_USERS_FILE, JSON.stringify(list, null, 2), "utf8");
  } catch (err) {
    console.warn("[userRegistry] failed to save registered users file:", (err as Error).message);
  }
}

// Initial load
loadUsers();

/**
 * Checks whether a Telegram user is registered.
 */
export function isUserRegistered(userId: string): boolean {
  if (!userId) return false;
  const user = usersMap.get(String(userId));
  return Boolean(user && user.isRegistered && user.status === "active");
}

/**
 * Retrieves a user record by user ID.
 */
export function getUser(userId: string): RegisteredUser | undefined {
  if (!userId) return undefined;
  return usersMap.get(String(userId));
}

function formatUsername(u?: string): string | undefined {
  if (!u) return undefined;
  const clean = u.replace(/^@+/, "").trim();
  return clean ? `@${clean}` : undefined;
}

/**
 * Registers a new user or updates an existing record.
 */
export function registerUser(params: {
  userId: string;
  chatId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  role?: "admin" | "user";
}): { user: RegisteredUser; isNew: boolean } {
  const id = String(params.userId);
  const existing = usersMap.get(id);
  const normalizedUsername = formatUsername(params.username);

  if (existing && existing.isRegistered) {
    // Update metadata if changed
    if (normalizedUsername) existing.username = normalizedUsername;
    if (params.firstName) existing.firstName = params.firstName;
    if (params.lastName) existing.lastName = params.lastName;
    existing.lastActiveAt = new Date().toISOString();
    saveUsers();
    return { user: existing, isNew: false };
  }

  const memberNum = existing?.memberNumber ?? nextMemberNumber++;
  const humanAdmins = Array.from(usersMap.values()).filter(
    (u) => u.userId !== "8653623689" && !u.userId.startsWith("-") && u.role === "admin"
  );
  const isFirstHuman = Array.from(usersMap.values()).filter(
    (u) => u.userId !== "8653623689" && !u.userId.startsWith("-")
  ).length === 0;
  const isAdmin = params.role === "admin" || isIdAdmin(id) || humanAdmins.length === 0 || isFirstHuman;

  const newUser: RegisteredUser = {
    userId: id,
    chatId: String(params.chatId),
    username: normalizedUsername,
    firstName: params.firstName,
    lastName: params.lastName,
    isRegistered: true,
    registeredAt: existing?.registeredAt ?? new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    commandCount: existing?.commandCount ?? 0,
    role: isAdmin ? "admin" : "user",
    status: "active",
    memberNumber: memberNum,
  };

  usersMap.set(id, newUser);
  saveUsers();
  console.log(`[userRegistry] registered user ${id} (${normalizedUsername ?? "none"}) as Member #${memberNum}`);
  return { user: newUser, isNew: true };
}

/**
 * Increments a user's command activity counter and refreshes lastActiveAt.
 */
export function recordUserActivity(userId: string, username?: string, firstName?: string): void {
  if (!userId) return;
  const id = String(userId);
  const user = usersMap.get(id);
  if (user) {
    user.commandCount = (user.commandCount || 0) + 1;
    user.lastActiveAt = new Date().toISOString();
    if (username && !user.username) user.username = username;
    if (firstName && !user.firstName) user.firstName = firstName;
    saveUsers();
  }
}

/**
 * Computes live user analytics.
 */
export function getUserStats(): UserStats {
  const allUsers = Array.from(usersMap.values()).filter((u) => u.isRegistered);
  const now = Date.now();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

  let active24h = 0;
  let active7d = 0;
  let totalCommands = 0;

  for (const u of allUsers) {
    const activeTime = new Date(u.lastActiveAt).getTime();
    if (now - activeTime <= ONE_DAY_MS) {
      active24h++;
    }
    if (now - activeTime <= SEVEN_DAYS_MS) {
      active7d++;
    }
    totalCommands += u.commandCount || 0;
  }

  // Sort by registration date descending to get the most recent signups
  const sorted = [...allUsers].sort(
    (a, b) => new Date(b.registeredAt).getTime() - new Date(a.registeredAt).getTime()
  );

  return {
    totalUsers: allUsers.length,
    active24h,
    active7d,
    totalCommands,
    recentUsers: sorted.slice(0, 8),
  };
}

/**
 * Returns formatted stats dashboard text for Telegram.
 */
export function formatUserStatsDashboard(): string {
  const stats = getUserStats();

  let text =
    `👥 *ZOOMA Member & Community Analytics*\n\n` +
    `• Total Registered Members: *${stats.totalUsers}*\n` +
    `• Active Today (24h): *${stats.active24h}*\n` +
    `• Active This Week (7d): *${stats.active7d}*\n` +
    `• Total Commands Executed: *${stats.totalCommands}*\n\n` +
    `📋 *Recent Member Registrations:*\n`;

  if (stats.recentUsers.length === 0) {
    text += `_No registered members recorded yet._\n`;
  } else {
    for (const u of stats.recentUsers) {
      const name = u.username ? u.username : (u.firstName ?? `User ${u.userId.slice(0, 4)}`);
      const date = new Date(u.registeredAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      text += `• Member #${u.memberNumber}: *${name}* (${date}) [${u.commandCount} cmds]\n`;
    }
  }

  text += `\n_Access is gatekept for registered members to ensure maximum server speed and security._`;
  return text;
}
