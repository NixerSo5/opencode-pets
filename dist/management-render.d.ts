/**
 * management-render.ts
 *
 * The Pets management tab (管理端 → 宠物), ported from the Control Center
 * renderer with the other tabs removed: two sub-tabs — 本机 (installed grid)
 * and 商城 (marketplace grid with category filters, search, pagination, and
 * one-click install).
 */
import { type PetStoreEntry } from "./pet-store.js";
export interface PetListItem {
    readonly id: string;
    readonly displayName: string;
    readonly description?: string;
    readonly spriteVersionNumber: 1 | 2;
    readonly spritesheetFileUrl: string;
    readonly builtIn: boolean;
    readonly isDefault: boolean;
}
export declare function buildPetListItems(installed: PetStoreEntry[], defaultPetId: string, builtInSpritesheetUrl: string): PetListItem[];
export interface ManagementWindowOptions {
    readonly items: readonly PetListItem[];
    readonly title?: string;
}
/** Full management-page HTML: 本机 tab + 商城 tab. */
export declare function createManagementHtml(options: ManagementWindowOptions): string;
