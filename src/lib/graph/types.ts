export interface GraphEmailAddress {
  name?: string;
  address?: string;
}

export interface GraphRecipient {
  emailAddress?: GraphEmailAddress;
}

export interface GraphMessage {
  id: string;
  conversationId: string;
  subject?: string | null;
  from?: GraphRecipient | null;
  sender?: GraphRecipient | null;
  toRecipients?: GraphRecipient[];
  body?: { contentType?: string; content?: string } | null;
  bodyPreview?: string | null;
  receivedDateTime: string;
  isRead?: boolean;
  internetMessageId?: string | null;
}

export interface GraphListResponse<T> {
  value: T[];
  "@odata.nextLink"?: string;
}
