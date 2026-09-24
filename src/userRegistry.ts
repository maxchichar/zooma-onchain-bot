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
  const envAdmin = process.env.TELEGRAM_CHAT_ID;
  const explicitAdmin = process.env.ADMIN_USER_ID;
  return Boolean(
    (envAdmin && envAdmin !== "8653623689" && envAdmin === id) ||
    (explicitAdmin && explicitAdmin === id)
  );
}

function loadUsers(): void {
  try {
    if (fs.existsSync(REGISTERED_USERS_FILE)) {
      const data = JSON.parse(fs.readFileSync(REGISTERED_USERS_FILE, "utf8"));
      if (Array.isArray(data)) {
        for (const u of data) {
          if (u && u.userId) {
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

  // Pre-seed any existing subscriber chats from .active_chats.json if not present
  try {
    if (fs.existsSync(ACTIVE_CHATS_FILE)) {
      const activeChats = JSON.parse(fs.readFileSync(ACTIVE_CHATS_FILE, "utf8"));
      if (Array.isArray(activeChats)) {
        for (const chatId of activeChats) {
          const strId = String(chatId);
          if (strId && !usersMap.has(strId)) {
            const num = nextMemberNumber++;
            const isAdmin = isIdAdmin(strId);
            usersMap.set(strId, {
              userId: strId,
              chatId: strId,
              firstName: isAdmin ? "System Admin" : "Early Member",
              isRegistered: true,
              registeredAt: new Date().toISOString(),
              lastActiveAt: new Date().toISOString(),
              commandCount: 0,
              role: isAdmin ? "admin" : "user",
              status: "active",
              memberNumber: num,
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn("[userRegistry] failed to sync active chats:", (err as Error).message);
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
  const isAdmin = params.role === "admin" || isIdAdmin(id);

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
