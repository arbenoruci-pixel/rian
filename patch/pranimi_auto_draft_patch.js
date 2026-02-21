
// TEPIHA PRANIMI AUTO-DRAFT PATCH
// Adds auto-draft creation when user enters first meaningful input

export async function ensureDraft(order, supabase) {
  if (!order) return;

  const hasInput =
    order.client_name ||
    order.phone ||
    (order.rows && order.rows.length > 0);

  if (!hasInput) return;

  // mark as draft if not already
  if (!order.status) {
    order.status = "draft";
  }

  // save locally
  localStorage.setItem("pranimi_draft_current", JSON.stringify(order));

  // optional: mirror to Supabase so other workers can continue
  try {
    await supabase.from("orders").upsert({
      code: order.code,
      status: "draft",
      client_name: order.client_name || null,
      phone: order.phone || null,
      payload: order
    });
  } catch (e) {
    console.log("Offline mode - draft saved locally");
  }
}
