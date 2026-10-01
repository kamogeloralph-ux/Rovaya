// Retired: photo deletion now lives in server/api/admin.ts (POST /api/v1/admin/photos/delete) and runs against
// D1 + R2 only. This empty module is kept so older checkouts that still have the file keep type-checking;
// it is safe to delete.
export {};
