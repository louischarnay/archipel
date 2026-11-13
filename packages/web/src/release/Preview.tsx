import { useRef, useState } from 'react';
import type { ReleaseDetail } from '../api/types';
import { Icon, type IconName } from '../components/Icon';
import { EmptyState, Segments } from '../components/Layout';
import { APP_SANDBOX } from '../pages/Viewer';

type Viewport = 'full' | 'tablet' | 'phone';

const VIEWPORTS: { id: Viewport; label: string; icon: IconName; width: number | null }[] = [
  { id: 'full', label: 'Computer', icon: 'desktop', width: null },
  { id: 'tablet', label: 'Tablet', icon: 'tablet', width: 820 },
  { id: 'phone', label: 'Phone', icon: 'phone', width: 390 },
];

function whyNoPreview(release: ReleaseDetail): [string, string] {
  if (release.status === 'processing') {
    return ['Preview not ready', 'The app opens here once the scan has passed and the preview is mounted.'];
  }
  if (release.manifest && !release.manifest.frontend) {
    return ['No frontend', 'This app declares no frontend: review its routes and tests in Technical details.'];
  }
  return ['No preview', 'A preview only runs while a version waits for review.'];
}

// The app as it will look once live, on empty tables. The frame stays mounted while the page refreshes around it.
export function PreviewPane({ release }: { release: ReleaseDetail }) {
  const [viewport, setViewport] = useState<Viewport>('full');
  const frame = useRef<HTMLIFrameElement>(null);
  const url = release.previewUrl;

  if (!url) {
    const [title, text] = whyNoPreview(release);
    return <EmptyState title={title} text={text} />;
  }
  const width = VIEWPORTS.find((item) => item.id === viewport)!.width;
  const reload = () => {
    if (frame.current) frame.current.src = url;
  };

  return (
    <div className="preview-pane">
      <div className="preview-bar">
        <Segments
          className="compact"
          label="Preview width"
          selected={viewport}
          onSelect={setViewport}
          tabs={VIEWPORTS.map(({ id, label, icon }) => ({ id, title: label, label: <Icon name={icon} /> }))}
        />
        <button className="btn small" type="button" title="Reload the app" onClick={reload}>
          <Icon name="reload" />
          Reload
        </button>
        <a className="btn small" href={url} target="_blank" rel="noopener">
          <Icon name="external" />
          New tab
        </a>
      </div>
      <iframe
        className="preview-frame"
        ref={frame}
        src={url}
        title="App preview"
        sandbox={APP_SANDBOX}
        style={{ maxWidth: width ? `${width}px` : undefined }}
      />
    </div>
  );
}
