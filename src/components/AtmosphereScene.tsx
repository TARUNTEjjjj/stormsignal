import { useId } from 'react';

/**
 * Decorative vector artwork in the Midnight Aurora palette. It is never a radar image or a
 * weather observation. The halo stays faint because the temperature can sit over its edge.
 */
export default function AtmosphereScene({ code }: { code: number | null | undefined }) {
  const id = useId().replaceAll(':', '');
  const cloudy = code != null && code > 1;
  const rainy = code != null && code >= 51 && ![71, 73, 75, 77, 85, 86].includes(code);
  const snowy = code != null && [71, 73, 75, 77, 85, 86].includes(code);
  return (
    <svg className="atmosphere-scene" viewBox="0 0 440 320" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id={`${id}-halo`}>
          <stop stopColor={rainy ? '#3ee6c1' : '#8b7cff'} stopOpacity=".16" />
          <stop offset=".55" stopColor={rainy ? '#3ee6c1' : '#8b7cff'} stopOpacity=".05" />
          <stop offset="1" stopColor="#5b6cff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}-orb`} cx=".32" cy=".22" r=".85">
          <stop stopColor="#fbfaff" />
          <stop offset=".45" stopColor="#c6beff" />
          <stop offset="1" stopColor="#5a4fc4" />
        </radialGradient>
        <linearGradient id={`${id}-rim`} x1="0" y1="1" x2="1" y2="0">
          <stop stopColor="#3ee6c1" stopOpacity=".9" />
          <stop offset=".5" stopColor="#3ee6c1" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}-ribbon`} x1="0" y1="0" x2="1" y2="0">
          <stop stopColor="#3ee6c1" stopOpacity="0" />
          <stop offset=".35" stopColor="#3ee6c1" />
          <stop offset=".7" stopColor="#8b7cff" />
          <stop offset="1" stopColor="#8b7cff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}-cloud`} x1="0" y1="0" x2=".15" y2="1">
          <stop stopColor="#d3dcf6" />
          <stop offset=".42" stopColor="#7c89b6" />
          <stop offset="1" stopColor="#28325a" />
        </linearGradient>
        <linearGradient id={`${id}-front`} x1="0" y1="0" x2=".3" y2="1">
          <stop stopColor="#e6ecff" />
          <stop offset=".45" stopColor="#8e9bc6" />
          <stop offset="1" stopColor="#323e6b" />
        </linearGradient>
        <linearGradient id={`${id}-rain`} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#7cf0d6" stopOpacity=".75" />
          <stop offset="1" stopColor="#7cf0d6" stopOpacity="0" />
        </linearGradient>
        <filter id={`${id}-shadow`} x="-40%" y="-40%" width="180%" height="200%">
          <feDropShadow dx="0" dy="15" stdDeviation="15" floodColor="#02040a" floodOpacity=".45" />
        </filter>
      </defs>
      <circle cx="268" cy="153" r="156" fill={`url(#${id}-halo)`} />
      <g fill="none" stroke={`url(#${id}-ribbon)`} strokeLinecap="round">
        <path d="M96 214C170 150 246 128 412 96" strokeWidth="26" strokeOpacity=".06" />
        <path d="M96 214C170 150 246 128 412 96" strokeWidth="1.4" strokeOpacity=".55" />
      </g>
      <g fill="none" stroke="#a0b2ff" strokeOpacity=".16" strokeWidth=".7">
        <circle cx="270" cy="155" r="126" />
        <circle cx="270" cy="155" r="99" strokeDasharray="2 7" />
        <ellipse cx="270" cy="155" rx="157" ry="46" transform="rotate(-28 270 155)" />
        <path d="M270 12v20m0 246v20M127 155h20m246 0h20" />
      </g>
      <g fill="#c9d3ff">
        <circle cx="152" cy="112" r="2" />
        <circle cx="375" cy="223" r="2.5" fill="#8ff3dc" />
        <circle cx="344" cy="52" r="1.5" />
        <circle cx="204" cy="273" r="1.3" />
        <circle cx="402" cy="146" r="1.1" />
      </g>
      {code != null && (
        <g filter={`url(#${id}-shadow)`}>
          <circle
            cx={cloudy ? 294 : 270}
            cy={cloudy ? 119 : 147}
            r={cloudy ? 56 : 73}
            fill={`url(#${id}-orb)`}
          />
          <circle
            cx={cloudy ? 294 : 270}
            cy={cloudy ? 119 : 147}
            r={cloudy ? 55 : 72}
            fill="none"
            stroke={`url(#${id}-rim)`}
            strokeWidth="1.5"
          />
        </g>
      )}
      {cloudy && (
        <g filter={`url(#${id}-shadow)`}>
          <path
            d="M211 178c-23 0-39-14-39-33 0-21 17-38 39-38 8-35 54-46 76-17 8-3 15-3 22-2 27 2 45 22 45 47 21-2 36 11 36 27 0 18-14 29-34 29H211Z"
            fill={`url(#${id}-cloud)`}
          />
          <path
            d="M163 215c-18 0-32-12-32-28 0-17 14-30 31-31 7-24 32-35 52-22 15-24 52-19 62 7 24-2 42 13 43 34 18 0 31 8 31 20 0 13-12 20-29 20H163Z"
            fill={`url(#${id}-front)`}
          />
        </g>
      )}
      {rainy && (
        <g stroke={`url(#${id}-rain)`} strokeWidth="2" strokeLinecap="round">
          {[177, 205, 233, 261, 289].map((x, i) => (
            <path key={x} d={`M${x} ${226 + (i % 2) * 8}l-8 28`} />
          ))}
        </g>
      )}
      {snowy && (
        <g fill="#e6eeff">
          {[179, 217, 255, 293].map((x, i) => (
            <circle key={x} cx={x} cy={235 + (i % 2) * 13} r="2.4" />
          ))}
        </g>
      )}
      {/* Pale violet-white, not amber: warm colours are kept for warnings. */}
      {code != null && code >= 95 && (
        <path d="m258 201-19 31h14l-9 23 29-34h-16l9-20Z" fill="#e9e4ff" />
      )}
      <g stroke="#a0b2ff" strokeOpacity=".16" fill="none">
        <path d="M86 286h310m-285 8h258m-229 8h207" />
      </g>
    </svg>
  );
}
