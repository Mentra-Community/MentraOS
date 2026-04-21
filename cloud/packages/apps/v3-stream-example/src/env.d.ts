/// <reference lib="dom" />

declare module "*.css";
declare module "*.html";

interface ImportMetaHotData {
  root?: import("react-dom/client").Root;
}

interface ImportMeta {
  hot?: {
    data: ImportMetaHotData;
  };
}
