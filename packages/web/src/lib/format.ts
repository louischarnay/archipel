const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

export const formatDate = (value: string | null | undefined) => (value ? dateFormat.format(new Date(value)) : '—');

export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
