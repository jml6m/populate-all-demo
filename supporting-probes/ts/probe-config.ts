/** Canonical run-ID format: YYYYMMDD-HHMMSS-<7hexchars|nogit> */
export const PROBE_RUN_ID_PATTERN = /^[0-9]{8}-[0-9]{6}-(?:[0-9a-f]{7}|nogit)$/;

export interface ProbeIdentity {
  readonly probe: string;
  readonly language: 'typescript' | 'python' | 'ruby' | 'java' | 'csharp';
  readonly library: string;
}

/**
 * Central registry of probe identity metadata — single source of truth for
 * name, language, and library across run-probes.ts and individual probe files.
 */
export const PROBE_IDENTITIES = {
  typeorm:      { probe: 'typeorm',      language: 'typescript' as const, library: 'TypeORM'      },
  sequelize:    { probe: 'sequelize',    language: 'typescript' as const, library: 'Sequelize'    },
  mikroorm:     { probe: 'mikroorm',     language: 'typescript' as const, library: 'MikroORM'     },
  prisma:       { probe: 'prisma',       language: 'typescript' as const, library: 'Prisma'       },
  mongoose:     { probe: 'mongoose',     language: 'typescript' as const, library: 'Mongoose'     },
  sqlalchemy:   { probe: 'sqlalchemy',   language: 'python'     as const, library: 'SQLAlchemy'   },
  activerecord: { probe: 'activerecord', language: 'ruby'       as const, library: 'ActiveRecord' },
  hibernate:    { probe: 'hibernate',    language: 'java'       as const, library: 'Hibernate'    },
  efcore:       { probe: 'efcore',       language: 'csharp'     as const, library: 'EF Core'      },
} as const satisfies Record<string, ProbeIdentity>;

export type ProbeLanguage = (typeof PROBE_IDENTITIES)[keyof typeof PROBE_IDENTITIES]['language'];
