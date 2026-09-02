import { config } from '../config';
import { getDb } from '../db';
import type { TowerProfile, UpdateTowerProfileInput } from '../types';

interface TowerMetadataRow {
  tower_name: string | null;
  tower_description: string | null;
  updated_at: Date;
}

function trimNullable(value: string | null | undefined) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function configuredTowerProfile(): TowerProfile {
  return {
    tower_name: trimNullable(config.tower.name),
    tower_description: trimNullable(config.tower.description),
    updated_at: null,
  };
}

function mergeTowerProfile(row?: TowerMetadataRow | null): TowerProfile {
  const fallback = configuredTowerProfile();
  return {
    tower_name: trimNullable(row?.tower_name) ?? fallback.tower_name,
    tower_description: trimNullable(row?.tower_description) ?? fallback.tower_description,
    updated_at: row?.updated_at ?? null,
  };
}

export async function getTowerProfile(): Promise<TowerProfile> {
  try {
    const sql = getDb();
    const [row] = await sql<TowerMetadataRow[]>`
      SELECT tower_name, tower_description, updated_at
      FROM tower_metadata
      WHERE singleton = TRUE
      LIMIT 1
    `;
    return mergeTowerProfile(row);
  } catch {
    return configuredTowerProfile();
  }
}

export async function updateTowerProfile(input: UpdateTowerProfileInput): Promise<TowerProfile> {
  const sql = getDb();
  const [current] = await sql<TowerMetadataRow[]>`
    SELECT tower_name, tower_description, updated_at
    FROM tower_metadata
    WHERE singleton = TRUE
    LIMIT 1
  `;

  const nextTowerName = input.tower_name === undefined ? (current?.tower_name ?? null) : trimNullable(input.tower_name);
  const nextTowerDescription = input.tower_description === undefined
    ? (current?.tower_description ?? null)
    : trimNullable(input.tower_description);

  const [updated] = await sql<TowerMetadataRow[]>`
    INSERT INTO tower_metadata (singleton, tower_name, tower_description, updated_at)
    VALUES (TRUE, ${nextTowerName}, ${nextTowerDescription}, NOW())
    ON CONFLICT (singleton) DO UPDATE
    SET tower_name = EXCLUDED.tower_name,
        tower_description = EXCLUDED.tower_description,
        updated_at = NOW()
    RETURNING tower_name, tower_description, updated_at
  `;

  return mergeTowerProfile(updated);
}
