# Odoo URL Builder - Claude Guide

> **Tool:** `build_odoo_url`
> **Purpose:** Generate clickable Odoo web URLs for direct navigation

## When to Use

Use this tool when the user asks for:
- "Give me a link to [something]"
- "How do I access [form/report] in Odoo?"
- "URL for [model] entry"
- "Link to edit [record]"
- "Open [screen] in Odoo"

## Prerequisites

Before this tool works, ensure:
1. `ir.ui.menu` is synced to Qdrant
2. `ir.actions.act_window` is synced to Qdrant
3. `ODOO_WEB_URL` or `ODOO_URL` is set in environment

To sync the required models:
```bash
npm run sync -- sync model ir.ui.menu
npm run sync -- sync model ir.actions.act_window
```

## URL Structure

The tool generates URLs in this format:
```
https://[BASE_URL]/web#cids=1&menu_id=[MENU_ID]&action=[ACTION_ID]&model=[MODEL]&view_type=[VIEW_TYPE]
```

| Parameter | Source | Description |
|-----------|--------|-------------|
| `cids` | Default: 1 | Company ID (multi-company) |
| `menu_id` | ir.ui.menu | Sidebar menu item ID |
| `action` | ir.actions.act_window | Action ID |
| `model` | ir.actions.act_window.res_model | Target Odoo model |
| `view_type` | ir.actions.act_window.view_mode | form, list, kanban, etc. |

## Workflow

1. **Identify User Intent**
   - What model? (e.g., account.move, crm.lead)
   - What view? (form for entry, list for browsing)
   - Specific record? (ID if editing existing)

2. **Choose Search Method**
   - If user mentions model name: use `model_name`
   - If user uses common terms: use `search_term`

3. **Call Tool**
   ```json
   {
     "model_name": "account.move",
     "view_type": "form"
   }
   ```

4. **Present Result**
   - Show the clickable URL(s)
   - Mention the menu path for manual navigation

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `model_name` | string | One of these | Odoo technical model name |
| `search_term` | string | required | Search action names |
| `view_type` | enum | Optional | form, list, kanban, pivot, graph, calendar |
| `record_id` | number | Optional | Specific record to open (form view) |

## Common Mappings

| User Says | model_name | view_type |
|-----------|------------|-----------|
| "bill", "vendor bill" | account.move | form |
| "invoice" | account.move | form |
| "customer", "contact" | res.partner | list |
| "opportunity", "deal" | crm.lead | kanban |
| "sales order" | sale.order | form |
| "purchase order" | purchase.order | form |
| "aged receivable" | (use search_term) | - |
| "aged payable" | (use search_term) | - |
| "balance sheet" | (use search_term) | - |

## Examples

### Example 1: Link to enter a new bill
**User:** "Link to enter a new bill"

**Call:**
```json
{ "model_name": "account.move", "view_type": "form" }
```

**Response:**
```
## Odoo URLs for "account.move"

### Vendor Bills
- **Action ID:** 325
- **Menu Path:** Invoicing / Vendors / Bills
- **View Modes:** list, form

**LIST:** https://example.com/web#cids=1&menu_id=204&action=325&model=account.move&view_type=list
**FORM:** https://example.com/web#cids=1&menu_id=204&action=325&model=account.move&view_type=form
```

### Example 2: URL for specific customer
**User:** "URL for customer 12345"

**Call:**
```json
{ "model_name": "res.partner", "record_id": 12345, "view_type": "form" }
```

### Example 3: Find aged receivable report
**User:** "Aged receivable report link"

**Call:**
```json
{ "search_term": "aged receivable" }
```

### Example 4: CRM opportunities
**User:** "Give me link to opportunities"

**Call:**
```json
{ "model_name": "crm.lead" }
```

## Error Handling

### "No actions found"
- Model may not have ir.actions.act_window synced
- Run: `npm run sync -- sync model ir.actions.act_window`

### "ODOO_WEB_URL not configured"
- Add to .env: `ODOO_WEB_URL=https://your-odoo.com`

### "Vector database not available"
- Check Qdrant is running
- Verify QDRANT_HOST environment variable

## Output Format

The tool returns markdown with:
- Action name as heading
- Action ID for reference
- Model name (technical)
- Menu ID and path (if menu exists)
- Available view modes
- Clickable URLs for each view type

Example output:
```markdown
## Odoo URLs for "account.move"

### Vendor Bills
- **Action ID:** 325
- **Model:** account.move
- **Menu ID:** 204
- **Menu Path:** Invoicing / Vendors / Bills
- **View Modes:** list, form

**LIST:** https://...
**FORM:** https://...
```
