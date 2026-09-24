/**
 * SNIPER ENGINE CONTROLLER
 * Manages the live state of the Pump.fun millisecond sniper and insider launch stream.
 * Provides instant start, stop, pause, and resume capabilities with local file persistence.
 * Zero em dashes across all code and text.
 */
import fs from "node:fs";
import path from "node:path";

export interface SniperState {
  enabled: boolean;
  totalAlertsDispatched: number;
  lastToggledAt: string;
}

const SNIPER_STATE_FILE = path.resolve(process.cwd(), ".sniper_state.json");

function readSniperState(): SniperState {
  try {
    if (fs.existsSync(SNIPER_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(SNIPER_STATE_FILE, "utf-8"));
      return {
        enabled: data.enabled !== false, // default true
        totalAlertsDispatched: Number(data.totalAlertsDispatched ?? 0),
        lastToggledAt: data.lastToggledAt || new Date().toISOString(),
      };
    }
  } catch (err) {
    console.warn("[sniperControl] error reading sniper state:", (err as Error).message);
  }
  return {
    enabled: true,
    totalAlertsDispatched: 0,
    lastToggledAt: new Date().toISOString(),
  };
}

function writeSniperState(state: SniperState): void {
  try {
    fs.writeFileSync(SNIPER_STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.warn("[sniperControl] error writing sniper state:", (err as Error).message);
  }
}

let inMemoryState = readSniperState();

export function isSniperActive(): boolean {
  return inMemoryState.enabled;
}

export function setSniperActive(enabled: boolean): SniperState {
  inMemoryState.enabled = enabled;
  inMemoryState.lastToggledAt = new Date().toISOString();
  writeSniperState(inMemoryState);
  return { ...inMemoryState };
}

export function incrementSniperAlerts(): void {
  inMemoryState.totalAlertsDispatched += 1;
  writeSniperState(inMemoryState);
}

export function getSniperState(): SniperState {
  return { ...inMemoryState };
}
