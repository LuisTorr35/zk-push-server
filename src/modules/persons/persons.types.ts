export type CreatePerson = { pin: string; name: string; externalId?: string | null };
export type UpdatePerson = { name?: string; externalId?: string | null };
export type ProfileAction = 'enroll' | 'delete-profile';
export type ProfileSnapshot = { pin: string; name: string; version: number };
export type ProfileCommand = {
  type: string;
  payload: string | null;
  dependencyMode?: 'confirmed' | 'finished';
  photoId?: string;
};
