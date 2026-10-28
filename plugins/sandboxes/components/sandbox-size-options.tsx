import { formatSizeTier, sandboxSizeTierValues, sizeTierUnits } from "../src/size-tiers.js";
import { SelectContent, SelectItem } from "./ui/select.js";

const COLUMNS = "grid w-56 grid-cols-[2rem_2rem_1fr_1fr] items-center gap-2 whitespace-nowrap text-right tabular-nums";

/** Keep the menu wider than its compact trigger, with aligned resource columns. */
export function SandboxSizeOptions({ projectDefault = false }: { projectDefault?: boolean }) {
  return <SelectContent className="w-72 min-w-0">
    {projectDefault && <SelectItem value="__default__" className="whitespace-nowrap">Project default</SelectItem>}
    <div aria-hidden="true" className="pb-1 pl-2 pr-8 pt-2 text-xs text-muted-foreground">
      <span className={COLUMNS}><span className="text-left">Size</span><span>CPU</span><span>RAM</span><span>Disk</span></span>
    </div>
    {sandboxSizeTierValues.map(tier => {
      const size = sizeTierUnits(tier);
      return <SelectItem key={tier} value={tier} className="whitespace-nowrap" textValue={formatSizeTier(tier)}>
        <span className="sr-only">{formatSizeTier(tier)}</span>
        <span aria-hidden="true" className={COLUMNS}>
          <span className="text-left font-medium">{tier}</span>
          <span className="text-muted-foreground">{size.cpu}</span>
          <span className="text-muted-foreground">{size.memoryGiB} GiB</span>
          <span className="text-muted-foreground">{size.diskGiB} GiB</span>
        </span>
      </SelectItem>;
    })}
  </SelectContent>;
}
