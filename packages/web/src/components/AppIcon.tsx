import { useState } from 'react';

interface Props {
  app: { id?: string | null; name?: string | null; hasIcon?: boolean; iconUrl?: string };
  small?: boolean;
}

// An app's or a link's icon. Without one, or when it does not load, its initial.
export function AppIcon({ app, small = false }: Props) {
  const [failed, setFailed] = useState(false);
  const className = small ? 'app-icon small' : 'app-icon';
  const src = app.iconUrl ?? (app.id ? `/api/apps/${encodeURIComponent(app.id)}/icon` : null);
  if (!app.hasIcon || !src || failed) {
    return <div className={className}>{(app.name ?? '?').charAt(0).toUpperCase()}</div>;
  }
  return <img className={className} src={src} alt="" onError={() => setFailed(true)} />;
}
