// 画面の移動など、どの画面からも使うもの（main.js が中身を入れる）
export const nav = {
  go: (path) => (location.hash = path),
  refreshSide: () => {},
  runSync: async () => {},
  rerender: () => {},
};
