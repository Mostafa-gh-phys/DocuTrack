# Security Specification — Folio Library & Cloud Sync

## 1. Data Invariants
1. **Strict Owner Isolation (PII & Private Library)**: Every collection under `/users/{userId}`—including user profiles (email, displayName), books, annotations, AI study courses, and preferences—is readable and writable ONLY by the verified authenticated owner (`request.auth.uid == userId` and `request.auth.token.email_verified == true`).
2. **Relational Referential Integrity**: Every `Annotation` and `StudyCourse` created under `/users/{userId}` MUST reference an existing book at `/users/{userId}/books/{bookId}` via `exists()` (or `existsAfter()` in batched writes).
3. **Immutable Ownership & Timestamps**: `ownerId` and `createdAt` cannot be modified after creation. `createdAt` on create and `updatedAt` on create/update must equal `request.time`.
4. **Bounded Payloads & Strict Keys**: Every write validates exact allowed keys (`hasAll` + `hasOnly` on create; `affectedKeys().hasOnly(...)` on update), bounded string sizes, valid enums (`pdf | epub | djvu`, `amber | sage | sky | rose`, `paper | sepia | dusk | night`), and valid regex IDs (`^[a-zA-Z0-9_\-]+$`).

## 2. The "Dirty Dozen" Adversarial Payloads (Must All Return PERMISSION_DENIED)
1. **Unauthenticated Book Read**: Unauthenticated client `get` on `/users/uid1/books/book1`.
2. **Cross-Tenant Book Read**: Authenticated `uid2` attempts `get` or `list` on `/users/uid1/books`.
3. **Unverified Email Write**: Authenticated `uid1` with `email_verified: false` attempts `create` on `/users/uid1/books/book1`.
4. **OwnerId Spoofing on Create**: `uid1` creates `/users/uid1/books/book1` with `ownerId: "uid2"`.
5. **Shadow Field Injection (Ghost Key)**: `uid1` creates `/users/uid1/books/book1` including `"isAdmin": true`.
6. **ID Poisoning (Oversized Path ID)**: `uid1` attempts `create` at `/users/uid1/books/${"a".repeat(200)}`.
7. **Format Enum Bypass**: `uid1` creates `/users/uid1/books/book1` with `format: "exe"`.
8. **Orphaned Annotation**: `uid1` creates `/users/uid1/annotations/ann1` with `bookId: "nonexistent_book"`.
9. **Immutable Owner Mutation on Update**: `uid1` updates `/users/uid1/books/book1` changing `ownerId` or `createdAt`.
10. **Client-Spoofed Timestamp**: `uid1` creates `/users/uid1/books/book1` with `createdAt: "1999-01-01T00:00:00Z"` instead of server `request.time`.
11. **Unbounded Array / Tag Flooding**: `uid1` creates a book with `tags` array containing 25 elements (exceeds max 10).
12. **PII Cross-User Profile Scrape**: Authenticated `uid2` attempts `get` on `/users/uid1` containing email PII.
