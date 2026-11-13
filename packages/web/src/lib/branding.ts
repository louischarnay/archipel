// The colours are attributes of the document: the stylesheet does the rest.
export function applyBranding({ accent, background }: { accent: string; background: string }) {
  document.documentElement.dataset.accent = accent;
  document.documentElement.dataset.background = background;
}
