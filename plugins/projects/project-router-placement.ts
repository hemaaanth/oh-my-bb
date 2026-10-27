export function createProjectRouterStatusTarget(anchor: HTMLElement): {
  target: HTMLElement;
  dispose: () => void;
} | null {
  const composer = anchor.closest<HTMLElement>('[data-app-composer-role="primary"]');
  if (!composer) return null;

  let bannerRow: HTMLElement | null = anchor.parentElement;
  while (bannerRow?.parentElement && bannerRow.parentElement !== composer) bannerRow = bannerRow.parentElement;
  const previousDisplay = bannerRow?.style.display ?? "";
  if (bannerRow?.parentElement === composer && bannerRow.childElementCount === 1) bannerRow.style.display = "none";

  const target = document.createElement("div");
  target.dataset.jevProjectRouterStatus = "";
  target.className = "mt-1 min-h-5 px-3.5";
  composer.appendChild(target);
  return {
    target,
    dispose() {
      target.remove();
      if (bannerRow?.isConnected) bannerRow.style.display = previousDisplay;
    },
  };
}
