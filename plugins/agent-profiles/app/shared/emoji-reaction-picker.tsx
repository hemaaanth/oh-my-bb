import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import {
  Airplane01Icon,
  BulbIcon,
  Clock01Icon,
  Coffee01Icon,
  Flag01Icon,
  FootballIcon,
  HashtagIcon,
  Leaf01Icon,
  SmileIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  loadedEmojiData,
  loadEmojiData,
  readRecentEmoji,
  rememberRecentEmoji,
  searchEmoji,
  withSkinTone,
  type EmojiCategory,
  type EmojiIndex,
  type SkinTone,
} from "./emoji-data";

const recentCategory = "recent";

const categoryIcons: Record<string, IconSvgElement> = {
  [recentCategory]: Clock01Icon,
  smileys_people: SmileIcon,
  animals_nature: Leaf01Icon,
  food_drink: Coffee01Icon,
  travel_places: Airplane01Icon,
  activities: FootballIcon,
  objects: BulbIcon,
  symbols: HashtagIcon,
  flags: Flag01Icon,
};

const skinTones: { tone: SkinTone; label: string; color: string }[] = [
  { tone: 0, label: "Default skin tone", color: "#ffd225" },
  { tone: 1, label: "Light skin tone", color: "#ffdfbd" },
  { tone: 2, label: "Medium-light skin tone", color: "#e9c197" },
  { tone: 3, label: "Medium skin tone", color: "#c88e62" },
  { tone: 4, label: "Medium-dark skin tone", color: "#a86637" },
  { tone: 5, label: "Dark skin tone", color: "#60463a" },
];

const defaultPreview = { emoji: "👍", label: "Choose a reaction" };

// Kept for the window, like the dataset, so reopening keeps the choice.
let chosenSkinTone: SkinTone = 0;

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

type Section = { id: string; name: string; emojis: { emoji: string; label: string; base: string }[] };

function toSection(category: EmojiCategory, tone: SkinTone): Section {
  return {
    id: category.id,
    name: category.name,
    emojis: category.emojis.map((entry) => ({ emoji: withSkinTone(entry, tone), label: entry.n[0] ?? "", base: entry.e })),
  };
}

function useEmojiData() {
  const [state, setState] = useState<{ index: EmojiIndex | null; error: string | null }>(() => ({
    index: loadedEmojiData(),
    error: null,
  }));
  const load = useCallback(() => {
    setState({ index: null, error: null });
    loadEmojiData().then(
      (index) => setState({ index, error: null }),
      (error: unknown) => setState({ index: null, error: error instanceof Error ? error.message : String(error) }),
    );
  }, []);
  useEffect(() => {
    if (!loadedEmojiData()) load();
  }, [load]);
  return { ...state, retry: load };
}

// The dataset is served by this plugin's server and fetched the first time a
// reaction picker opens (see server/emoji-data.ts), keeping it out of app.js.
export function EmojiReactionPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const { index, error, retry } = useEmojiData();
  const [query, setQuery] = useState("");
  const [tone, setTone] = useState<SkinTone>(chosenSkinTone);
  const [toneOpen, setToneOpen] = useState(false);
  const [preview, setPreview] = useState<{ emoji: string; label: string } | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [recent] = useState(() => {
    const store = storage();
    return store ? readRecentEmoji(store) : [];
  });
  const body = useRef<HTMLDivElement>(null);

  const sections = useMemo<Section[]>(() => {
    if (!index) return [];
    if (query) return searchEmoji(index.data, query).map((category) => toSection(category, tone));
    const all = index.data.categories.map((category) => toSection(category, tone));
    if (recent.length === 0) return all;
    const recentSection: Section = {
      id: recentCategory,
      name: "Recently Used",
      emojis: recent.map((emoji) => {
        const entry = index.byCharacter.get(emoji);
        return { emoji, label: entry?.n[0] ?? "", base: entry?.e ?? emoji };
      }),
    };
    return [recentSection, ...all];
  }, [index, query, tone, recent]);

  // A new query (or the data arriving) starts from the top; a skin tone
  // change keeps the scroll position.
  const firstSection = sections[0]?.id ?? null;
  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
    setActive(firstSection);
  }, [query, index, firstSection]);

  const pick = useCallback(
    (emoji: string, base: string) => {
      const store = storage();
      if (store) rememberRecentEmoji(store, emoji, base);
      onPick(emoji);
    },
    [onPick],
  );

  const chooseTone = (next: SkinTone) => {
    chosenSkinTone = next;
    setTone(next);
    setToneOpen(false);
  };

  const emojiButtons = () => Array.from(body.current?.querySelectorAll<HTMLButtonElement>("button[data-emoji]") ?? []);

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      const first = sections[0]?.emojis[0];
      if (first) {
        event.preventDefault();
        pick(first.emoji, first.base);
      }
    } else if (event.key === "ArrowDown") {
      const first = emojiButtons()[0];
      if (first) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = event.target as HTMLElement;
    if (!current.dataset.emoji) return;
    const buttons = emojiButtons();
    const at = buttons.indexOf(current as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (event.key === "ArrowRight") next = buttons[at + 1];
    else if (event.key === "ArrowLeft") next = buttons[at - 1];
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      // Nearest column in the next or previous row, across section breaks.
      const down = event.key === "ArrowDown";
      const { offsetTop: top, offsetLeft: left } = current;
      const candidates = down ? buttons.slice(at + 1) : buttons.slice(0, at).reverse();
      const rowTop = candidates.find((button) => (down ? button.offsetTop > top : button.offsetTop < top))?.offsetTop;
      if (rowTop === undefined && !down) {
        event.preventDefault();
        body.current?.parentElement?.querySelector<HTMLInputElement>("input")?.focus();
        return;
      }
      next = candidates
        .filter((button) => button.offsetTop === rowTop)
        .sort((a, b) => Math.abs(a.offsetLeft - left) - Math.abs(b.offsetLeft - left))[0];
    } else return;
    if (next) {
      event.preventDefault();
      next.focus();
      next.scrollIntoView({ block: "nearest" });
    }
  };

  const onScroll = () => {
    const container = body.current;
    if (!container) return;
    const sections = Array.from(container.querySelectorAll<HTMLElement>("section[data-category]"));
    let current = sections[0]?.dataset.category ?? null;
    for (const section of sections) {
      if (section.offsetTop - container.scrollTop <= 1) current = section.dataset.category ?? current;
    }
    setActive(current);
  };

  const jumpTo = (id: string) => {
    const container = body.current;
    const section = container?.querySelector<HTMLElement>(`section[data-category="${id}"]`);
    if (!container || !section) return;
    container.scrollTo({ top: section.offsetTop });
    setActive(id);
  };

  const navigation = index
    ? [...(recent.length > 0 ? [{ id: recentCategory, name: "Recently Used" }] : []), ...index.data.categories]
    : [];
  const shown = preview ?? defaultPreview;

  return (
    <div className="flex h-full flex-col">
      <div className="relative flex items-center gap-2 p-2">
        <Input
          autoFocus
          aria-label="Search emoji"
          placeholder="Search emoji…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
        />
        {toneOpen ? (
          <div role="radiogroup" aria-label="Skin tone" className="absolute inset-y-2 right-2 flex items-center gap-1 rounded-md bg-popover pl-1">
            {skinTones.map((option) => (
              <button
                key={option.tone}
                type="button"
                role="radio"
                aria-checked={option.tone === tone}
                aria-label={option.label}
                className="size-5 shrink-0 cursor-pointer rounded-full border border-border aria-checked:ring-1 aria-checked:ring-ring"
                style={{ background: option.color }}
                onClick={() => chooseTone(option.tone)}
              />
            ))}
          </div>
        ) : (
          <button
            type="button"
            aria-label="Choose skin tone"
            className="size-5 shrink-0 cursor-pointer rounded-full border border-border"
            style={{ background: skinTones[tone]?.color }}
            onClick={() => setToneOpen(true)}
          />
        )}
      </div>
      {index ? (
        <nav aria-label="Emoji categories" className="flex justify-between border-b border-border px-2 pb-1">
          {navigation.map((category) => (
            <button
              key={category.id}
              type="button"
              aria-label={category.name}
              aria-pressed={!query && active === category.id}
              disabled={Boolean(query)}
              className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent aria-pressed:text-foreground"
              onClick={() => jumpTo(category.id)}
            >
              <HugeiconsIcon icon={categoryIcons[category.id] ?? SmileIcon} className="size-4" aria-hidden />
            </button>
          ))}
        </nav>
      ) : null}
      <div ref={body} className="relative min-h-0 flex-1 overflow-y-auto px-2" onScroll={onScroll}>
        {index ? (
          sections.length > 0 ? (
            <EmojiSections sections={sections} onPick={pick} onPreview={setPreview} onKeyDown={onGridKeyDown} />
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">No emoji found</p>
          )
        ) : error ? (
          <div role="alert" className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <p>Couldn't load emoji.</p>
            <Button variant="outline" size="sm" onClick={retry}>
              Retry
            </Button>
          </div>
        ) : (
          <p role="status" className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading emoji…
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-border px-3 py-2">
        <span className="text-2xl leading-none" aria-hidden>
          {shown.emoji}
        </span>
        <span className="truncate text-sm text-muted-foreground">{shown.label}</span>
      </div>
    </div>
  );
}

// Memoized so hover previews do not re-render ~1,900 buttons. Handlers are
// delegated from each grid to its buttons' data attributes.
const EmojiSections = memo(function EmojiSections({
  sections,
  onPick,
  onPreview,
  onKeyDown,
}: {
  sections: Section[];
  onPick: (emoji: string, base: string) => void;
  onPreview: (preview: { emoji: string; label: string } | null) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const target = (event: SyntheticEvent) => (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-emoji]");
  const show = (event: SyntheticEvent) => {
    const button = target(event);
    if (button) onPreview({ emoji: button.dataset.emoji ?? "", label: button.getAttribute("aria-label") ?? "" });
  };
  return (
    <div
      onClick={(event) => {
        const button = target(event);
        if (button) onPick(button.dataset.emoji ?? "", button.dataset.base ?? "");
      }}
      onPointerOver={show}
      onFocus={show}
      onPointerLeave={() => onPreview(null)}
      onKeyDown={onKeyDown}
    >
      {sections.map((section) => (
        <section key={section.id} data-category={section.id} aria-label={section.name}>
          <h3
            className="sticky top-0 z-10 bg-popover py-1 text-xs font-medium text-muted-foreground"
          >
            {section.name}
          </h3>
          <div className="grid grid-cols-8">
            {section.emojis.map((item) => (
              <button
                key={item.emoji}
                type="button"
                tabIndex={-1}
                data-emoji={item.emoji}
                data-base={item.base}
                aria-label={item.label || item.emoji}
                className="flex aspect-square cursor-pointer items-center justify-center rounded-md text-2xl leading-none hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none"
              >
                {item.emoji}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
});
