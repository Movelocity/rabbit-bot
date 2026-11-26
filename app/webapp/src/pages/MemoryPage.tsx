import { Fragment, useState } from "react";
import { cx } from "../lib/cx.ts";
import { MemoriesPage } from "./MemoriesPage.tsx";
import { BusinessPage } from "./BusinessPage.tsx";

type Step = "entries" | "graph";

const STEPS: { value: Step; label: string; hint?: string }[] = [
  { value: "entries", label: "条目" },
  { value: "graph", label: "图谱", hint: "只读" },
];

function initialStep(): Step {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get("tab");
  if (tab === "business") return "graph";
  if (tab === "manage" && params.get("view") === "business") return "graph";
  return "entries";
}

function StepSwitch({
  step,
  onChange,
}: {
  step: Step;
  onChange: (step: Step) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="记忆视图">
      {STEPS.map((item, index) => {
        const active = step === item.value;
        return (
          <Fragment key={item.value}>
            {index > 0 ? (
              <span aria-hidden="true" className="text-[13px] text-line-strong">
                →
              </span>
            ) : null}
            <button
              type="button"
              className={cx(
                "flex items-center gap-2 rounded-[8px] border px-3 py-1.5 text-[12.5px] transition",
                active
                  ? "border-accent/45 bg-surface text-text shadow-[0_0_0_3px_var(--rb-accent-soft)]"
                  : "border-border bg-surface text-muted hover:border-line-strong hover:text-text",
              )}
              aria-pressed={active}
              onClick={() => onChange(item.value)}
            >
              <b
                className={cx(
                  "grid h-5 w-5 place-items-center rounded-full text-[11px] font-semibold",
                  active
                    ? "bg-accent text-[color:var(--rb-surface)]"
                    : "bg-surface2 text-muted",
                )}
              >
                {index + 1}
              </b>
              {item.label}
              {item.hint ? (
                <span className="text-[11px] text-faint">{item.hint}</span>
              ) : null}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}

export function MemoryPage({ reloadSignal }: { reloadSignal: number }) {
  const [step, setStep] = useState<Step>(initialStep);
  const control = <StepSwitch step={step} onChange={setStep} />;

  return step === "entries" ? (
    <MemoriesPage reloadSignal={reloadSignal} header={control} />
  ) : (
    <BusinessPage reloadSignal={reloadSignal} viewSwitch={control} />
  );
}