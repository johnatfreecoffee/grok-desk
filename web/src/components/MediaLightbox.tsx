/**
 * Full-screen preview for images, video, audio, PDF.
 */
import { X } from "lucide-react";

export type MediaKind = "image" | "video" | "audio" | "pdf" | "file";

export type MediaItem = {
  url: string;
  name?: string;
  kind?: MediaKind;
};

export function guessMediaKind(url: string, name = ""): MediaKind {
  const s = `${name} ${url}`.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|svg|avif)(\?|$)/i.test(s)) return "image";
  if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(s)) return "video";
  if (/\.(mp3|wav|m4a|ogg|aac)(\?|$)/i.test(s)) return "audio";
  if (/\.(pdf)(\?|$)/i.test(s)) return "pdf";
  return "file";
}

type Props = {
  item: MediaItem | null;
  onClose: () => void;
};

export function MediaLightbox({ item, onClose }: Props) {
  if (!item) return null;
  const kind = item.kind || guessMediaKind(item.url, item.name);
  return (
    <div className="media-lightbox" role="dialog" aria-modal="true" aria-label={item.name || "Preview"}>
      <button type="button" className="media-lightbox-backdrop" aria-label="Close" onClick={onClose} />
      <div className="media-lightbox-frame">
        <header className="media-lightbox-bar">
          <span className="media-lightbox-name">{item.name || kind}</span>
          <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="media-lightbox-body">
          {kind === "image" ? (
            <img src={item.url} alt={item.name || ""} />
          ) : kind === "video" ? (
            <video src={item.url} controls autoPlay playsInline />
          ) : kind === "audio" ? (
            <audio src={item.url} controls autoPlay />
          ) : kind === "pdf" ? (
            <iframe title={item.name || "PDF"} src={item.url} />
          ) : (
            <a href={item.url} target="_blank" rel="noreferrer" className="linkish">
              Open {item.name || "file"}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
