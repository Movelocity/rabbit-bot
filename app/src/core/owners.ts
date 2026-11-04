/**
 * 「谁是他」——主人名单。
 *
 * 群聊里默认只有被 @ 才唤醒，主人的话是例外：他说什么都要回，而且不等人 @。
 * 名单从 config 的 `adapters.<平台>.ownerIds` 读，main 启动时灌进来；
 * 放全局是因为 hub（判唤醒）、prompt（标 [主人]）两处都要用，而它们不属于同一个层。
 */
let ids = new Set<string>();

export function setOwnerIds(list: (string | null | undefined)[]): void {
  ids = new Set(list.filter((x): x is string => !!x).map((x) => x.trim().toLowerCase()));
}

export function isOwnerId(id?: string | null): boolean {
  return !!id && ids.has(id.trim().toLowerCase());
}

export function ownerIds(): string[] {
  return [...ids];
}
