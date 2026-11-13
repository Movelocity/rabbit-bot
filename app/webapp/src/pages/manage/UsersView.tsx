import { useCallback, useEffect, useState } from "react";
import { useApi } from "../../lib/api-context.tsx";
import { friendlyError } from "../../lib/format.ts";
import type { User } from "../../lib/types.ts";
import {
  Badge,
  Button,
  Card,
  CardHead,
  CardMeta,
  CardTitle,
  Empty,
  Input,
  StatusText,
} from "../../components/ui.tsx";

function UserCard({
  user,
  onSaved,
  onError,
}: {
  user: User;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const request = useApi();
  const [alias, setAlias] = useState(user.alias || "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setAlias(user.alias || "");
  }, [user.alias]);

  const save = async () => {
    setSaving(true);
    try {
      await request(`/v1/users/${encodeURIComponent(user.user_id)}`, {
        method: "PATCH",
        body: { alias, backfill: true },
      });
      onSaved();
    } catch (e) {
      onError(`保存失败：${friendlyError(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHead>
        <CardTitle>{user.alias || user.display_name || user.user_id}</CardTitle>
        <Badge variant={user.alias ? "info" : "default"}>
          {user.alias ? "有别名" : "自动名"}
        </Badge>
      </CardHead>
      <CardMeta>
        <span>{user.user_id}</span>
        {user.identities.map((i) => (
          <span key={`${i.platform}:${i.platform_user_id}`}>
            {i.platform}:{i.platform_user_id}
          </span>
        ))}
      </CardMeta>
      <div className="mt-2.5 flex gap-2">
        <Input
          className="min-w-0 flex-1"
          type="text"
          value={alias}
          placeholder={user.display_name || "给这个用户起个别名"}
          onChange={(e) => setAlias(e.target.value)}
        />
        <Button variant="primary" size="sm" disabled={saving} onClick={() => void save()}>
          {saving ? "保存中…" : "保存别名"}
        </Button>
      </div>
    </Card>
  );
}

export function UsersView({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [rows, setRows] = useState<User[]>([]);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });

  const load = useCallback(async () => {
    setStatus({ text: "加载中…" });
    try {
      const data = await request<User[]>("/v1/users");
      setRows(data);
      setStatus({ text: data.length ? "" : "还没有识别到用户。" });
    } catch (e) {
      setStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
    }
  }, [request]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (reloadSignal === 0) return;
    void load();
  }, [reloadSignal, load]);

  return (
    <>
      <StatusText text={status.text} error={status.error} />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-2.5">
        {!rows.length ? (
          <Empty>还没有识别到用户。</Empty>
        ) : (
          rows.map((u) => (
            <UserCard
              key={u.user_id}
              user={u}
              onSaved={() => void load()}
              onError={(message) => setStatus({ text: message, error: true })}
            />
          ))
        )}
      </div>
    </>
  );
}
