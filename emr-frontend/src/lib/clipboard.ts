/**
 * კოპირება ბუფერში. navigator.clipboard მუშაობს მხოლოდ "უსაფრთხო კონტექსტში" (HTTPS ან localhost) —
 * http://<IP>-ზე ის არ არსებობს, ამიტომ fallback: დროებითი textarea + execCommand('copy').
 * აბრუნებს true მხოლოდ რეალური წარმატებისას.
 */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fallback ქვემოთ */ }
  }
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', '');
  ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  const prev = document.activeElement as HTMLElement | null;
  ta.select(); ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.body.removeChild(ta); prev?.focus();
  return ok;
}
