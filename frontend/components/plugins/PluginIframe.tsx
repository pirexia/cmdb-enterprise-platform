"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/contexts/LanguageContext";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PluginIframeProps {
  pluginId: string;
  slotName: string;
  context?: Record<string, unknown>;
  className?: string;
}

// Messages the host sends to the plugin iframe
interface CmdbInitMessage {
  type: "cmdb:init";
  // The JWT lives in an HttpOnly cookie (not accessible to JS).
  // We pass null here; the plugin iframe's API calls go through the same
  // HttpOnly cookie automatically. T7 may add scoped ephemeral tokens later.
  token: null;
  locale: string;
  theme: "light";
  context: Record<string, unknown>;
}

// Messages the plugin iframe sends to the host
interface CmdbResizeMessage {
  type: "cmdb:resize";
  height: number;
}

interface CmdbNavigateMessage {
  type: "cmdb:navigate";
  path: string;
}

type InboundPluginMessage = CmdbResizeMessage | CmdbNavigateMessage;

// ─── Component ────────────────────────────────────────────────────────────────

const INITIAL_HEIGHT = 200;

export default function PluginIframe({
  pluginId,
  slotName,
  context = {},
  className,
}: PluginIframeProps) {
  const { t, locale } = useLanguage();
  const router = useRouter();

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(INITIAL_HEIGHT);
  const [loadError, setLoadError] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Send cmdb:init to the iframe once it has loaded
  const sendInit = useCallback(() => {
    if (!iframeRef.current?.contentWindow) return;
    const msg: CmdbInitMessage = {
      type: "cmdb:init",
      token: null,
      locale,
      theme: "light",
      context,
    };
    iframeRef.current.contentWindow.postMessage(msg, window.location.origin);
  }, [locale, context]);

  // Handle incoming messages from the plugin iframe
  const handleMessage = useCallback(
    (event: MessageEvent) => {
      // Security: only accept messages from same origin
      if (event.origin !== window.location.origin) return;
      // Ignore messages not from this specific iframe
      if (
        iframeRef.current?.contentWindow &&
        event.source !== iframeRef.current.contentWindow
      ) {
        return;
      }

      const data = event.data as InboundPluginMessage;
      if (!data || typeof data.type !== "string") return;

      switch (data.type) {
        case "cmdb:resize": {
          const newHeight = Number(data.height);
          if (Number.isFinite(newHeight) && newHeight > 0) {
            setHeight(newHeight);
            if (iframeRef.current) {
              iframeRef.current.style.height = `${newHeight}px`;
            }
          }
          break;
        }
        case "cmdb:navigate": {
          const targetPath = String(data.path ?? "");
          // Only allow internal navigation (must start with /)
          if (targetPath.startsWith("/")) {
            router.push(targetPath);
          }
          break;
        }
        default:
          break;
      }
    },
    [router]
  );

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [handleMessage]);

  const handleLoad = () => {
    setLoaded(true);
    setLoadError(false);
    sendInit();
  };

  const handleError = () => {
    setLoadError(true);
    setLoaded(true);
  };

  const src = `/api/plugins/${encodeURIComponent(pluginId)}/ui?slot=${encodeURIComponent(slotName)}`;

  return (
    <div className={`relative w-full overflow-hidden ${className ?? ""}`}>
      {/* Loading skeleton shown before iframe fires onLoad */}
      {!loaded && (
        <div
          className="absolute inset-0 flex items-center justify-center bg-slate-800/30 text-xs text-slate-500"
          style={{ height: `${height}px` }}
        >
          <span className="animate-pulse">{t("pluginIframeLoading")}</span>
        </div>
      )}

      {loadError ? (
        <div
          className="flex items-center justify-center bg-red-900/20 text-xs text-red-400 rounded"
          style={{ height: `${height}px` }}
        >
          {t("pluginIframeError")}
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          src={src}
          sandbox="allow-scripts allow-same-origin"
          style={{ height: `${height}px` }}
          className="w-full border-0 block"
          onLoad={handleLoad}
          onError={handleError}
          title={`Plugin ${pluginId} — ${slotName}`}
          aria-label={`Plugin slot: ${slotName}`}
        />
      )}
    </div>
  );
}
