/**
 * URL Builder Tool
 *
 * Generates clickable Odoo web URLs for direct navigation to forms, lists, and reports.
 *
 * Prerequisites:
 * - ir.ui.menu and ir.actions.act_window must be synced to Qdrant
 * - ODOO_WEB_URL or ODOO_URL must be set in environment
 *
 * URL Structure:
 * https://[BASE_URL]/web#cids=1&menu_id=[MENU_ID]&action=[ACTION_ID]&model=[MODEL]&view_type=[VIEW_TYPE]
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BuildOdooUrlSchema } from '../schemas/index.js';
import { scrollRecords } from '../services/scroll-engine.js';
import { buildQdrantFilter } from '../services/filter-builder.js';
import { ODOO_CONFIG } from '../constants.js';
import { isVectorClientAvailable } from '../services/vector-client.js';
import { FilterCondition } from '../types.js';

// =============================================================================
// TYPES
// =============================================================================

interface ActionRecord {
  record_id?: number;
  name?: string;
  res_model?: string;
  view_mode?: string;
  target?: string;
  context?: string;
}

/**
 * Check if an action's context requires active_id
 * Actions with active_id in context are designed to be opened FROM another record
 * and will fail when opened directly via URL
 */
function isContextDependent(context: string | undefined): boolean {
  if (!context) return false;
  return context.includes('active_id') || context.includes('active_ids');
}

interface MenuRecord {
  record_id?: number;
  name?: string;
  action?: string;
  complete_name?: string;
  parent_id?: number;
}

interface UrlResult {
  actionId: number;
  actionName: string;
  model: string;
  menuId?: number;
  menuPath?: string;
  viewModes: string[];
  urls: { viewType: string; url: string }[];
}

// =============================================================================
// TOOL REGISTRATION
// =============================================================================

export function registerUrlBuilderTool(server: McpServer): void {
  server.tool(
    'build_odoo_url',
    `Generate Odoo web URLs for direct navigation to forms, lists, and reports.

USAGE:
- By model: build_odoo_url({ model_name: "account.move" })
- By search: build_odoo_url({ search_term: "vendor bill" })
- Specific record: build_odoo_url({ model_name: "res.partner", record_id: 12345, view_type: "form" })

RETURNS:
- List of matching actions with clickable URLs
- Menu path for navigation reference
- Available view types

REQUIRES:
- ir.ui.menu and ir.actions.act_window must be synced to Qdrant
- ODOO_WEB_URL or ODOO_URL environment variable must be set`,
    BuildOdooUrlSchema.shape,
    async (args) => {
      try {
        const input = BuildOdooUrlSchema.parse(args);
        const { model_name, view_type, record_id, search_term } = input;

        // Validate at least one search criteria provided
        if (!model_name && !search_term) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Error: Provide either model_name or search_term.\n\nExamples:\n- build_odoo_url({ model_name: "account.move" })\n- build_odoo_url({ search_term: "vendor bill" })'
            }]
          };
        }

        // Check vector client availability
        if (!isVectorClientAvailable()) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Vector database not available. Check QDRANT_HOST configuration.'
            }]
          };
        }

        // Check base URL configuration
        const baseUrl = ODOO_CONFIG.WEB_URL || ODOO_CONFIG.URL;
        if (!baseUrl) {
          return {
            content: [{
              type: 'text' as const,
              text: 'ODOO_WEB_URL or ODOO_URL not configured.\n\nAdd to your .env file:\nODOO_WEB_URL=https://your-odoo-instance.com'
            }]
          };
        }

        // Step 1: Find matching actions from ir.actions.act_window
        const actionFilterConditions: FilterCondition[] = [];
        if (model_name) {
          actionFilterConditions.push({ field: 'res_model', op: 'eq', value: model_name });
        }

        const actionFilterResult = buildQdrantFilter('ir.actions.act_window', actionFilterConditions);
        const actionResult = await scrollRecords(actionFilterResult.qdrantFilter, {
          fields: ['record_id', 'name', 'res_model', 'view_mode', 'target', 'context'],
          limit: 100,
          appFilters: actionFilterResult.appFilters
        });

        let actions = actionResult.records as unknown as ActionRecord[];

        // If no model_name filter and search_term provided, filter actions by name
        if (search_term && actions.length > 0) {
          const searchLower = search_term.toLowerCase();
          actions = actions.filter(a =>
            a.name?.toLowerCase().includes(searchLower) ||
            a.res_model?.toLowerCase().includes(searchLower)
          );
        }

        // If model_name not provided but search_term found matches, use those
        if (!model_name && search_term && actions.length === 0) {
          // Try searching all actions by name
          const allActionsResult = buildQdrantFilter('ir.actions.act_window', []);
          const allActions = await scrollRecords(allActionsResult.qdrantFilter, {
            fields: ['record_id', 'name', 'res_model', 'view_mode', 'target', 'context'],
            limit: 500,
            appFilters: allActionsResult.appFilters
          });

          const searchLower = search_term.toLowerCase();
          actions = (allActions.records as unknown as ActionRecord[]).filter(a =>
            a.name?.toLowerCase().includes(searchLower)
          );
        }

        // Filter out context-dependent actions (those requiring active_id)
        // These fail when opened directly via URL
        const contextDependentActions = actions.filter(a => isContextDependent(a.context));
        const safeActions = actions.filter(a => !isContextDependent(a.context));

        // Use safe actions if available
        if (safeActions.length > 0) {
          actions = safeActions;
        } else if (contextDependentActions.length > 0 && search_term) {
          // All window actions are context-dependent - try menu search before giving up
          // This helps when searching "vendor bill" but safe action is under "Bills" menu
          const menuFallbackResult = buildQdrantFilter('ir.ui.menu', []);
          const menuFallbackSearch = await scrollRecords(menuFallbackResult.qdrantFilter, {
            fields: ['record_id', 'name', 'action', 'complete_name'],
            limit: 500,
            appFilters: menuFallbackResult.appFilters
          });

          const searchLower = search_term.toLowerCase();
          const fallbackMenus = (menuFallbackSearch.records as unknown as MenuRecord[]).filter(m =>
            m.name?.toLowerCase().includes(searchLower) ||
            m.complete_name?.toLowerCase().includes(searchLower)
          );

          if (fallbackMenus.length > 0) {
            // Found menus - return menu-based URLs instead
            const output: string[] = [];
            output.push(`## Menu URLs for "${search_term}"\n`);
            output.push(`*Note: Window actions found are context-dependent. Using menu-based URLs instead.*\n`);

            for (const menu of fallbackMenus.slice(0, 10)) {
              if (!menu.record_id) continue;

              let actionId: string | undefined;
              if (menu.action) {
                const match = menu.action.match(/,(\d+)$/);
                actionId = match ? match[1] : menu.action;
              }

              output.push(`### ${menu.name}`);
              if (menu.complete_name) {
                output.push(`- **Menu Path:** ${menu.complete_name}`);
              }
              output.push(`- **Menu ID:** ${menu.record_id}`);
              if (actionId) {
                output.push(`- **Action:** ${menu.action}`);
              }

              const urlParams = [`cids=1`, `menu_id=${menu.record_id}`];
              if (actionId) {
                urlParams.push(`action=${actionId}`);
              }
              const url = `${baseUrl}/web#${urlParams.join('&')}`;
              output.push(`\n**URL:** ${url}\n`);
            }

            return {
              content: [{
                type: 'text' as const,
                text: output.join('\n')
              }]
            };
          }

          // No menus found either - show context-dependent warning
          const searchCriteria = model_name
            ? `model "${model_name}"`
            : `search term "${search_term}"`;

          return {
            content: [{
              type: 'text' as const,
              text: `Found ${contextDependentActions.length} action(s) for ${searchCriteria}, but they all require opening from another record (context-dependent).

These actions have 'active_id' in their context and cannot be opened directly via URL.

**Workaround:** Navigate manually in Odoo:
1. Go to the related record first (e.g., Partner)
2. Use the action button/menu from there

Or try a direct model URL (may not have all filters):
${baseUrl}/web#model=${model_name || 'account.move'}&view_type=list`
            }]
          };
        } else if (contextDependentActions.length > 0) {
          // All context-dependent but no search term to try menu search
          return {
            content: [{
              type: 'text' as const,
              text: `Found ${contextDependentActions.length} action(s) for model "${model_name}", but they all require opening from another record (context-dependent).

These actions have 'active_id' in their context and cannot be opened directly via URL.

**Workaround:** Navigate manually in Odoo or try a direct model URL:
${baseUrl}/web#model=${model_name}&view_type=list`
            }]
          };
        }

        if (actions.length === 0) {
          // No window actions found - try searching menus directly
          // This helps find reports (ir.actions.client) and other action types
          if (search_term) {
            const menuFilterResult = buildQdrantFilter('ir.ui.menu', []);
            const menuSearchResult = await scrollRecords(menuFilterResult.qdrantFilter, {
              fields: ['record_id', 'name', 'action', 'complete_name'],
              limit: 500,
              appFilters: menuFilterResult.appFilters
            });

            const searchLower = search_term.toLowerCase();
            const matchingMenus = (menuSearchResult.records as unknown as MenuRecord[]).filter(m =>
              m.name?.toLowerCase().includes(searchLower) ||
              m.complete_name?.toLowerCase().includes(searchLower)
            );

            if (matchingMenus.length > 0) {
              // Found menus matching search - build URLs from menu action references
              const output: string[] = [];
              output.push(`## Menu URLs for "${search_term}"\n`);
              output.push(`*Found ${matchingMenus.length} menu(s) matching your search:*\n`);

              for (const menu of matchingMenus.slice(0, 10)) {
                if (!menu.record_id) continue;

                // Extract action ID from menu.action (format: "ir.actions.X,ID" or just "ID")
                let actionId: string | undefined;
                if (menu.action) {
                  const match = menu.action.match(/,(\d+)$/);
                  actionId = match ? match[1] : menu.action;
                }

                output.push(`### ${menu.name}`);
                if (menu.complete_name) {
                  output.push(`- **Menu Path:** ${menu.complete_name}`);
                }
                output.push(`- **Menu ID:** ${menu.record_id}`);
                if (actionId) {
                  output.push(`- **Action:** ${menu.action}`);
                }

                // Build URL
                const urlParams = [`cids=1`, `menu_id=${menu.record_id}`];
                if (actionId) {
                  urlParams.push(`action=${actionId}`);
                }
                const url = `${baseUrl}/web#${urlParams.join('&')}`;
                output.push(`\n**URL:** ${url}\n`);
              }

              if (matchingMenus.length > 10) {
                output.push(`\n*...and ${matchingMenus.length - 10} more menus*`);
              }

              return {
                content: [{
                  type: 'text' as const,
                  text: output.join('\n')
                }]
              };
            }
          }

          const searchCriteria = model_name
            ? `model "${model_name}"`
            : `search term "${search_term}"`;

          return {
            content: [{
              type: 'text' as const,
              text: `No actions or menus found for ${searchCriteria}.

Possible reasons:
1. ir.actions.act_window not synced yet
   Run: npm run sync -- sync model ir.actions.act_window

2. Model name incorrect (use Odoo technical name like "account.move")

3. Search term doesn't match any action or menu names

4. For reports, try searching by the exact report name`
            }]
          };
        }

        // Step 2: Get all menu items for matching action references
        const menuFilterResult = buildQdrantFilter('ir.ui.menu', []);
        const menuResult = await scrollRecords(menuFilterResult.qdrantFilter, {
          fields: ['record_id', 'name', 'action', 'complete_name', 'parent_id'],
          limit: 1000,
          appFilters: menuFilterResult.appFilters
        });

        const menus = menuResult.records as unknown as MenuRecord[];

        // Step 3: Build URLs for each action
        const results: UrlResult[] = [];

        for (const action of actions.slice(0, 10)) { // Limit to 10 results
          if (!action.record_id) continue;

          // Find menu item that references this action
          // Menu action format: "ir.actions.act_window,123" or just "123"
          const actionRef1 = `ir.actions.act_window,${action.record_id}`;
          const actionRef2 = String(action.record_id);

          const matchingMenu = menus.find(
            m => m.action === actionRef1 || m.action === actionRef2
          );

          // Parse view modes
          const viewModes = (action.view_mode || 'list,form').split(',').map(v => v.trim());

          // Build URL for each view type
          const urls: { viewType: string; url: string }[] = [];

          for (const vt of viewModes) {
            // Skip if user requested specific view_type and this isn't it
            if (view_type && vt !== view_type) continue;

            const urlParams: string[] = ['cids=1'];

            if (matchingMenu?.record_id) {
              urlParams.push(`menu_id=${matchingMenu.record_id}`);
            }
            urlParams.push(`action=${action.record_id}`);
            if (action.res_model) {
              urlParams.push(`model=${action.res_model}`);
            }
            urlParams.push(`view_type=${vt}`);

            // Add record_id for form views if provided
            if (record_id && vt === 'form') {
              urlParams.push(`id=${record_id}`);
            }

            const url = `${baseUrl}/web#${urlParams.join('&')}`;
            urls.push({ viewType: vt, url });
          }

          if (urls.length > 0) {
            results.push({
              actionId: action.record_id,
              actionName: action.name || 'Unknown',
              model: action.res_model || 'Unknown',
              menuId: matchingMenu?.record_id,
              menuPath: matchingMenu?.complete_name || matchingMenu?.name,
              viewModes,
              urls
            });
          }
        }

        // Step 4: Format output
        if (results.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `No URLs could be generated. Actions found but no matching view types.`
            }]
          };
        }

        const output: string[] = [];
        const title = model_name || search_term || 'Results';
        output.push(`## Odoo URLs for "${title}"\n`);

        for (const result of results) {
          output.push(`### ${result.actionName}`);
          output.push(`- **Action ID:** ${result.actionId}`);
          output.push(`- **Model:** ${result.model}`);
          if (result.menuId) {
            output.push(`- **Menu ID:** ${result.menuId}`);
          }
          if (result.menuPath) {
            output.push(`- **Menu Path:** ${result.menuPath}`);
          }
          output.push(`- **View Modes:** ${result.viewModes.join(', ')}`);
          output.push('');

          for (const { viewType, url } of result.urls) {
            output.push(`**${viewType.toUpperCase()}:** ${url}`);
          }
          output.push('');
        }

        if (actions.length > 10) {
          output.push(`\n*...and ${actions.length - 10} more actions available*`);
        }

        return {
          content: [{
            type: 'text' as const,
            text: output.join('\n')
          }]
        };

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [{
            type: 'text' as const,
            text: `Error building Odoo URL: ${errorMsg}`
          }]
        };
      }
    }
  );

  console.error('[UrlBuilder] Registered tool: build_odoo_url');
}
