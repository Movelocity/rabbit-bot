import { Segmented } from "../components/ui.tsx";
import { useRoute } from "../lib/use-route.tsx";
import { MemoriesPage } from "./MemoriesPage.tsx";
import { BusinessPage } from "./BusinessPage.tsx";

export function MemoryPage({ reloadSignal }: { reloadSignal: number }) {
  const { route, navigate } = useRoute();
  const view = route.tab === "memories" ? route.view : "entries";

  const control = (
    <Segmented
      value={view}
      onChange={(next) => navigate({ tab: "memories", view: next })}
      label="记忆视图"
      options={[
        { value: "entries", label: "条目" },
        { value: "graph", label: "图谱 只读" },
      ]}
    />
  );

  return view === "entries" ? (
    <MemoriesPage reloadSignal={reloadSignal} header={control} />
  ) : (
    <BusinessPage reloadSignal={reloadSignal} viewSwitch={control} />
  );
}