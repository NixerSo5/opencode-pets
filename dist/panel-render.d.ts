/**
 * panel-render.ts
 *
 * HTML for the standalone chat panel window. The panel is its own BrowserWindow
 * anchored next to the pet (Ant Design Popconfirm model), so the pet window
 * never resizes or moves when the chat opens.
 */
export interface PanelPageOptions {
    /** Display name used as the placeholder header until the session title arrives. */
    readonly petName?: string;
}
export declare function createPanelPageHtml(options?: PanelPageOptions): string;
