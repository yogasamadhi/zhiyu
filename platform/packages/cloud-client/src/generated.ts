export interface paths {
  '/api/cloud/v1/health': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Database and cache readiness */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                /** @enum {string} */
                database: 'available';
                /** @enum {string} */
                cache: 'available' | 'degraded';
                /** @enum {string} */
                payments: 'simulation' | 'disabled';
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/catalog': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Published test subscriptions */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                simulation: boolean;
                prices: {
                  /** Format: uuid */
                  id: string;
                  config: {
                    name: string;
                    /** @enum {string} */
                    cycle: 'month' | 'year';
                    amountFen: number;
                    credits: number;
                    modelIds: string[];
                  };
                }[];
                models: {
                  /** Format: uuid */
                  id: string;
                  name: string;
                }[];
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/auth/challenges': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Send phone or email verification challenge */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            target: string;
            /** @enum {string} */
            purpose: 'login' | 'verify' | 'reset' | 'bind';
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                /** Format: uuid */
                challengeId: string;
                expiresAt: string;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/auth/verify': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Consume challenge, verify or securely bind identity */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: uuid */
            challengeId: string;
            code: string;
            password?: string;
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data:
                | {
                    csrf: string;
                    expiresAt: string;
                  }
                | {
                    /** @enum {boolean} */
                    bound: true;
                  };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/auth/login': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Email password login */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: email */
            email: string;
            password: string;
            totp?: string;
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                csrf: string;
                expiresAt: string;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/auth/logout': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Revoke current session */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': Record<string, never>;
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data?: unknown;
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/me': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Private account summary */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                /** Format: uuid */
                id: string;
                csrf: string;
                identities: {
                  /** Format: uuid */
                  id: string;
                  target: string;
                  verified: boolean;
                }[];
                balance: {
                  available: number;
                  reserved: number;
                  expiresAt: string | null;
                };
                terms: {
                  /** Format: uuid */
                  id: string;
                  /** Format: uuid */
                  user_id: string;
                  /** Format: uuid */
                  order_id: string;
                  starts_at: string;
                  ends_at: string;
                  anchor: string;
                  anchor_offset: number;
                  months: number;
                  revoked_at: string | null;
                }[];
                agreements: {
                  /** Format: uuid */
                  id: string;
                  /** Format: uuid */
                  user_id: string;
                  /** Format: uuid */
                  price_id: string;
                  /** @enum {string} */
                  channel: 'mock-wechat' | 'mock-alipay';
                  status: string;
                  next_at: string | null;
                  created_at: string;
                }[];
                /** @enum {string} */
                environment: 'test';
                /** @enum {number} */
                deviceLimit: 2;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/me/orders': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** List own orders */
    get: {
      parameters: {
        query?: {
          limit?: string;
          cursor?: string;
          q?: string;
          status?: 'pending' | 'paid' | 'failed' | 'canceled' | 'closed' | 'refunded';
          from?: string;
          to?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                items: {
                  /** Format: uuid */
                  id: string;
                  /** Format: uuid */
                  user_id: string;
                  /** Format: uuid */
                  price_id: string;
                  snapshot: {
                    [key: string]: unknown;
                  };
                  /** @enum {string} */
                  channel: 'mock-wechat' | 'mock-alipay';
                  key: string;
                  /** @enum {string} */
                  status: 'pending' | 'paid' | 'failed' | 'canceled' | 'closed' | 'refunded';
                  /** Format: uuid */
                  agreement_id: string | null;
                  cycle_at: string | null;
                  created_at: string;
                  /** @enum {string} */
                  environment: 'test';
                }[];
                nextCursor: string | null;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/me/credits': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** List own credits */
    get: {
      parameters: {
        query?: {
          limit?: string;
          cursor?: string;
          q?: string;
          status?: 'grant' | 'reserve' | 'settle' | 'release' | 'expire' | 'adjust' | 'refund';
          from?: string;
          to?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                items: {
                  /** Format: uuid */
                  id: string;
                  /** Format: uuid */
                  user_id: string;
                  /** Format: uuid */
                  period_id: string;
                  /** @enum {string} */
                  kind: 'grant' | 'reserve' | 'settle' | 'release' | 'expire' | 'adjust' | 'refund';
                  amount: number;
                  key: string;
                  /** Format: uuid */
                  request_id: string | null;
                  created_at: string;
                }[];
                nextCursor: string | null;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/me/periods': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** List own periods */
    get: {
      parameters: {
        query?: {
          limit?: string;
          cursor?: string;
          q?: string;
          status?: 'scheduled' | 'active' | 'expired' | 'revoked';
          from?: string;
          to?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                items: {
                  /** Format: uuid */
                  id: string;
                  /** Format: uuid */
                  user_id: string;
                  /** Format: uuid */
                  term_id: string;
                  starts_at: string;
                  ends_at: string;
                  allowance: number;
                  available: number;
                  reserved: number;
                  /** @enum {string} */
                  state: 'scheduled' | 'active' | 'expired' | 'revoked';
                }[];
                nextCursor: string | null;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/me/devices': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** List own devices */
    get: {
      parameters: {
        query?: {
          limit?: string;
          cursor?: string;
          q?: string;
          status?: 'unrevoked' | 'revoked';
          from?: string;
          to?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                items: {
                  /** Format: uuid */
                  id: string;
                  /** Format: uuid */
                  user_id: string;
                  name: string;
                  revoked_at: string | null;
                  created_at: string;
                }[];
                nextCursor: string | null;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/me/sessions': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** List own sessions */
    get: {
      parameters: {
        query?: {
          limit?: string;
          cursor?: string;
          q?: string;
          status?: 'unrevoked' | 'revoked';
          from?: string;
          to?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                items: {
                  /** Format: uuid */
                  id: string;
                  /** Format: uuid */
                  device_id: string | null;
                  created_at: string;
                  expires_at: string;
                  revoked_at: string | null;
                }[];
                nextCursor: string | null;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/me/usage': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** List own usage */
    get: {
      parameters: {
        query?: {
          limit?: string;
          cursor?: string;
          q?: string;
          status?: 'reserved' | 'calling' | 'settled' | 'released' | 'review';
          from?: string;
          to?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                items: {
                  /** Format: uuid */
                  id: string;
                  turn_id: string;
                  /** @enum {string} */
                  status: 'reserved' | 'calling' | 'settled' | 'released' | 'review';
                  input_tokens: number | null;
                  output_tokens: number | null;
                  cost: number | null;
                  /** Format: uuid */
                  model_id: string;
                  created_at: string;
                }[];
                nextCursor: string | null;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/users': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Inspect users */
    get: {
      parameters: {
        query?: {
          limit?: string;
          cursor?: string;
          q?: string;
          status?: 'active' | 'disabled';
          from?: string;
          to?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                items: {
                  /** Format: uuid */
                  id: string;
                  status: string;
                  created_at: string;
                }[];
                nextCursor: string | null;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/prices': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Inspect prices */
    get: {
      parameters: {
        query?: {
          limit?: string;
          cursor?: string;
          q?: string;
          status?: 'published' | 'draft';
          from?: string;
          to?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                items: {
                  /** Format: uuid */
                  id: string;
                  config: {
                    [key: string]: unknown;
                  };
                  published: boolean;
                  created_at: string;
                }[];
                nextCursor: string | null;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    /** Create immutable price and allowance version */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            name: string;
            amountFen: number;
            /** @enum {string} */
            cycle: 'month' | 'year';
            credits: number;
            modelIds: string[];
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data?: unknown;
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/models': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Inspect models */
    get: {
      parameters: {
        query?: {
          limit?: string;
          cursor?: string;
          q?: string;
          status?: 'enabled' | 'disabled';
          from?: string;
          to?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                items: {
                  /** Format: uuid */
                  id: string;
                  config: {
                    [key: string]: unknown;
                  };
                  tested_at: string | null;
                  enabled: boolean;
                  created_at: string;
                }[];
                nextCursor: string | null;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    /** Create immutable model and rate version */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            name: string;
            upstreamModel: string;
            /** Format: uri */
            baseUrl?: string;
            keyRef?: string;
            /** @enum {string} */
            adapter: 'mock' | 'openai-compatible';
            inputRate: number;
            outputRate: number;
            maxOutput: number;
            maxContext: number;
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data?: unknown;
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/subscriptions': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Inspect subscriptions */
    get: {
      parameters: {
        query?: {
          limit?: string;
          cursor?: string;
          q?: string;
          status?: 'unrevoked' | 'revoked';
          from?: string;
          to?: string;
          userId?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                items: {
                  /** Format: uuid */
                  id: string;
                  /** Format: uuid */
                  user_id: string;
                  /** Format: uuid */
                  order_id: string;
                  starts_at: string;
                  ends_at: string;
                  anchor: string;
                  anchor_offset: number;
                  months: number;
                  revoked_at: string | null;
                }[];
                nextCursor: string | null;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/orders': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Inspect orders */
    get: {
      parameters: {
        query?: {
          limit?: string;
          cursor?: string;
          q?: string;
          status?: 'pending' | 'paid' | 'failed' | 'canceled' | 'closed' | 'refunded';
          from?: string;
          to?: string;
          userId?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                items: {
                  /** Format: uuid */
                  id: string;
                  /** Format: uuid */
                  user_id: string;
                  /** Format: uuid */
                  price_id: string;
                  snapshot: {
                    [key: string]: unknown;
                  };
                  /** @enum {string} */
                  channel: 'mock-wechat' | 'mock-alipay';
                  key: string;
                  /** @enum {string} */
                  status: 'pending' | 'paid' | 'failed' | 'canceled' | 'closed' | 'refunded';
                  /** Format: uuid */
                  agreement_id: string | null;
                  cycle_at: string | null;
                  created_at: string;
                  /** @enum {string} */
                  environment: 'test';
                }[];
                nextCursor: string | null;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/refunds': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Inspect refunds */
    get: {
      parameters: {
        query?: {
          limit?: string;
          cursor?: string;
          q?: string;
          status?: 'pending' | 'confirmed';
          from?: string;
          to?: string;
          userId?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                items: {
                  /** Format: uuid */
                  id: string;
                  /** Format: uuid */
                  order_id: string;
                  status: string;
                  reason: string;
                  created_at: string;
                }[];
                nextCursor: string | null;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    /** Request a simulated full refund */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: uuid */
            orderId: string;
            reason: string;
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data?: unknown;
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/credits': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Inspect credits */
    get: {
      parameters: {
        query?: {
          limit?: string;
          cursor?: string;
          q?: string;
          status?: 'grant' | 'reserve' | 'settle' | 'release' | 'expire' | 'adjust' | 'refund';
          from?: string;
          to?: string;
          userId?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                items: {
                  /** Format: uuid */
                  id: string;
                  /** Format: uuid */
                  user_id: string;
                  /** Format: uuid */
                  period_id: string;
                  /** @enum {string} */
                  kind: 'grant' | 'reserve' | 'settle' | 'release' | 'expire' | 'adjust' | 'refund';
                  amount: number;
                  key: string;
                  /** Format: uuid */
                  request_id: string | null;
                  created_at: string;
                }[];
                nextCursor: string | null;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/periods': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Inspect periods */
    get: {
      parameters: {
        query?: {
          limit?: string;
          cursor?: string;
          q?: string;
          status?: 'scheduled' | 'active' | 'expired' | 'revoked';
          from?: string;
          to?: string;
          userId?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                items: {
                  /** Format: uuid */
                  id: string;
                  /** Format: uuid */
                  user_id: string;
                  /** Format: uuid */
                  term_id: string;
                  starts_at: string;
                  ends_at: string;
                  allowance: number;
                  available: number;
                  reserved: number;
                  /** @enum {string} */
                  state: 'scheduled' | 'active' | 'expired' | 'revoked';
                }[];
                nextCursor: string | null;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/devices': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Inspect devices */
    get: {
      parameters: {
        query?: {
          limit?: string;
          cursor?: string;
          q?: string;
          status?: 'unrevoked' | 'revoked';
          from?: string;
          to?: string;
          userId?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                items: {
                  /** Format: uuid */
                  id: string;
                  /** Format: uuid */
                  user_id: string;
                  name: string;
                  revoked_at: string | null;
                  created_at: string;
                }[];
                nextCursor: string | null;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/staff': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Inspect staff */
    get: {
      parameters: {
        query?: {
          limit?: string;
          cursor?: string;
          q?: string;
          status?: 'owner' | 'support' | 'finance' | 'operator';
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                items: {
                  /** Format: uuid */
                  id: string;
                  email: string;
                  /** @enum {string} */
                  role: 'owner' | 'support' | 'finance' | 'operator';
                  disabled: boolean;
                }[];
                nextCursor: string | null;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    /** Create staff with mandatory TOTP enrollment */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: email */
            email: string;
            password: string;
            /** @enum {string} */
            role: 'support' | 'finance' | 'operator';
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data?: unknown;
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/jobs': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Inspect jobs */
    get: {
      parameters: {
        query?: {
          limit?: string;
          cursor?: string;
          q?: string;
          status?: 'pending' | 'running' | 'done' | 'failed';
          from?: string;
          to?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                items: {
                  /** Format: uuid */
                  id: string;
                  key: string;
                  kind: string;
                  payload: {
                    [key: string]: unknown;
                  };
                  due_at: string;
                  status: string;
                  locked_until: string | null;
                  attempts: number;
                  last_error: string | null;
                  created_at: string;
                }[];
                nextCursor: string | null;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/audit': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Inspect audit */
    get: {
      parameters: {
        query?: {
          limit?: string;
          cursor?: string;
          q?: string;
          from?: string;
          to?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                items: {
                  /** Format: uuid */
                  id: string;
                  /** Format: uuid */
                  actor_id: string | null;
                  action: string;
                  resource_id: string | null;
                  detail: {
                    [key: string]: unknown;
                  };
                  created_at: string;
                }[];
                nextCursor: string | null;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/requests': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Inspect requests */
    get: {
      parameters: {
        query?: {
          limit?: string;
          cursor?: string;
          q?: string;
          status?: 'reserved' | 'calling' | 'settled' | 'released' | 'review';
          from?: string;
          to?: string;
          userId?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                items: {
                  /** Format: uuid */
                  id: string;
                  turn_id: string;
                  /** @enum {string} */
                  status: 'reserved' | 'calling' | 'settled' | 'released' | 'review';
                  input_tokens: number | null;
                  output_tokens: number | null;
                  cost: number | null;
                  error_code: string | null;
                  /** Format: uuid */
                  user_id: string;
                  /** Format: uuid */
                  model_id: string;
                  reserved: number;
                  created_at: string;
                }[];
                nextCursor: string | null;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/agreements': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Inspect agreements */
    get: {
      parameters: {
        query?: {
          limit?: string;
          cursor?: string;
          q?: string;
          status?: 'pending' | 'active' | 'canceling' | 'canceled';
          from?: string;
          to?: string;
          userId?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                items: {
                  /** Format: uuid */
                  id: string;
                  /** Format: uuid */
                  user_id: string;
                  /** Format: uuid */
                  price_id: string;
                  /** @enum {string} */
                  channel: 'mock-wechat' | 'mock-alipay';
                  status: string;
                  next_at: string | null;
                  created_at: string;
                }[];
                nextCursor: string | null;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/inbox': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Inspect inbox */
    get: {
      parameters: {
        query?: {
          limit?: string;
          cursor?: string;
          q?: string;
          from?: string;
          to?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                items: {
                  /** Format: uuid */
                  id: string;
                  /** Format: uuid */
                  challenge_id: string;
                  target: string;
                  code: string;
                  expires_at: string;
                }[];
                nextCursor: string | null;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/me/sessions/revoke': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Revoke own session */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: uuid */
            id: string;
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data?: unknown;
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/me/devices/revoke': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Unbind device immediately */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: uuid */
            id: string;
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data?: unknown;
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/billing/orders': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Create simulated checkout */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: uuid */
            priceId: string;
            /** @enum {string} */
            channel: 'mock-wechat' | 'mock-alipay';
            key: string;
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                user_id: string;
                /** Format: uuid */
                price_id: string;
                snapshot: {
                  [key: string]: unknown;
                };
                /** @enum {string} */
                channel: 'mock-wechat' | 'mock-alipay';
                key: string;
                /** @enum {string} */
                status: 'pending' | 'paid' | 'failed' | 'canceled' | 'closed' | 'refunded';
                /** Format: uuid */
                agreement_id: string | null;
                cycle_at: string | null;
                created_at: string;
                /** @enum {string} */
                environment: 'test';
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/billing/agreements': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Prepare simulated recurring agreement */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: uuid */
            priceId: string;
            /** @enum {string} */
            channel: 'mock-wechat' | 'mock-alipay';
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                user_id: string;
                /** Format: uuid */
                price_id: string;
                /** @enum {string} */
                channel: 'mock-wechat' | 'mock-alipay';
                status: string;
                next_at: string | null;
                created_at: string;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/billing/agreements/cancel': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Stop future charges; keep paid term */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: uuid */
            id: string;
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data?: unknown;
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/simulation/payment': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Simulate payment notification scenarios */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: uuid */
            orderId: string;
            /** @enum {string} */
            scenario:
              'success' | 'failure' | 'cancel' | 'delay' | 'duplicate' | 'out-of-order' | 'unknown';
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data?: unknown;
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/simulation/agreement': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Confirm simulated agreement */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: uuid */
            id: string;
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data?: unknown;
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/desktop/authorize': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Authorize PKCE loopback desktop */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            challenge: string;
            /** Format: uri */
            redirectUri: string;
            /** Format: uuid */
            deviceId: string;
            deviceName: string;
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                code: string;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/desktop/exchange': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Exchange one-time authorization with PKCE */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            code: string;
            verifier: string;
            /** Format: uri */
            redirectUri: string;
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                csrf: string;
                expiresAt: string;
                access: string;
                refresh: string;
                /** Format: uuid */
                sessionId: string;
                /** Format: uuid */
                deviceId: string;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/desktop/refresh': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Rotate desktop refresh credential */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            refreshToken: string;
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                csrf: string;
                expiresAt: string;
                access: string;
                refresh: string;
                /** Format: uuid */
                sessionId: string;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/ai/models': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Available hosted models for this account */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                /** Format: uuid */
                id: string;
                name: string;
                inputRate: number;
                outputRate: number;
                maxOutput: number;
                /** @enum {string} */
                environment: 'test';
              }[];
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/ai/chat/completions': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Reserve credits and stream hosted model output */
    post: {
      parameters: {
        query?: never;
        header: {
          'x-request-id': string;
          'x-assistant-turn': string;
        };
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: uuid */
            model: string;
            messages: {
              /** @enum {string} */
              role: 'system' | 'user' | 'assistant' | 'tool';
              content?: string | null;
              tool_calls?: {
                id: string;
                /** @enum {string} */
                type: 'function';
                function: {
                  name: string;
                  arguments: string;
                };
              }[];
              tool_call_id?: string;
            }[];
            tools?: {
              /** @enum {string} */
              type: 'function';
              function: {
                name: string;
                description?: string;
                parameters: {
                  [key: string]: unknown;
                };
              };
            }[];
            tool_choice?: unknown;
            temperature?: number;
            response_format?: unknown;
            stream?: boolean;
            stream_options?: unknown;
            max_tokens?: number;
          };
        };
      };
      responses: {
        /** @description OpenAI-compatible stream or completion */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'text/event-stream': string;
            'application/json': unknown;
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/ai/status': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Get request settlement status */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: uuid */
            id: string;
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                /** Format: uuid */
                id: string;
                turn_id: string;
                /** @enum {string} */
                status: 'reserved' | 'calling' | 'settled' | 'released' | 'review';
                input_tokens: number | null;
                output_tokens: number | null;
                cost: number | null;
                error_code: string | null;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/ai/cancel': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Request cancellation without re-dispatch */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: uuid */
            id: string;
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data?: unknown;
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/login': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Independent staff password and TOTP login */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: email */
            email: string;
            password: string;
            totp?: string;
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                csrf: string;
                expiresAt: string;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/me': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Staff role and CSRF token */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data: {
                /** Format: uuid */
                id: string;
                /** @enum {string} */
                role: 'owner' | 'support' | 'operator' | 'finance';
                csrf: string;
              };
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/metrics': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Worker heartbeat and accounting health */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data?: unknown;
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/logout': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Revoke staff session */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': Record<string, never>;
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data?: unknown;
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/models/test': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Test configured upstream before enabling */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: uuid */
            id: string;
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data?: unknown;
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/models/disable': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Disable new requests on model version */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: uuid */
            id: string;
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data?: unknown;
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/prices/publish': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Publish a complete test subscription */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: uuid */
            id: string;
            published: boolean;
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data?: unknown;
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/simulation/refund': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Confirm simulated channel refund */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: uuid */
            orderId: string;
            /** @enum {string} */
            scenario: 'success' | 'unknown';
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data?: unknown;
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/simulation/payment': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Exercise payment fault scenarios */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: uuid */
            orderId: string;
            /** @enum {string} */
            scenario:
              'success' | 'failure' | 'cancel' | 'delay' | 'duplicate' | 'out-of-order' | 'unknown';
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data?: unknown;
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/simulation/agreement': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Configure recurring debit failure scenario */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            scenario:
              'success' | 'failure' | 'cancel' | 'delay' | 'duplicate' | 'out-of-order' | 'unknown';
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data?: unknown;
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/credits/adjust': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Audited credit compensation */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: uuid */
            periodId: string;
            amount: number;
            key: string;
            reason: string;
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data?: unknown;
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/devices/revoke': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Revoke device and cloud credentials */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: uuid */
            id: string;
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data?: unknown;
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/users/status': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Suspend cloud account only */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            status: 'active' | 'disabled';
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data?: unknown;
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/jobs/retry': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Retry durable failed task */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: uuid */
            id: string;
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data?: unknown;
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/requests/release': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Release uncertain reservation as audited compensation; never retry upstream */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: uuid */
            id: string;
            reason: string;
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data?: unknown;
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/cloud/v1/admin/staff/disable': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Disable staff and revoke sessions */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: {
        content: {
          'application/json': {
            /** Format: uuid */
            id: string;
          };
        };
      };
      responses: {
        /** @description Success */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              data?: unknown;
            };
          };
        };
        /** @description Invalid request */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Authentication required */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description Permission denied */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
        /** @description State conflict */
        409: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            'application/json': {
              error: {
                code: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: never;
  responses: never;
  parameters: never;
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
