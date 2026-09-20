export interface Contact {
  displayName: string | null;
  email: string | null;
}

export interface ContactSummary {
  label: string;
  email: string | null;
}

export function summarizeContact(contact: Contact): ContactSummary {
  const name = contact.displayName.trim();
  const email = contact.email.trim().toLowerCase();
  return {
    label: name || email || "Anonymous contact",
    email,
  };
}
