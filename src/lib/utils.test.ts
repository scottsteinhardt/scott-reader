import { describe, it, expect } from 'vitest'
import { countWords, md5 } from '../core/utils'

describe('utils', () => {
  describe('countWords', () => {
    it('counts words in plain text', () => {
      expect(countWords('hello world')).toBe(2)
    })

    it('strips HTML tags before counting', () => {
      expect(countWords('<p>hello <b>world</b></p>')).toBe(2)
    })

    it('normalizes whitespace', () => {
      expect(countWords('  hello   world  ')).toBe(2)
    })

    it('handles empty/null input', () => {
      expect(countWords('')).toBe(0)
      expect(countWords(null)).toBe(0)
      expect(countWords(undefined)).toBe(0)
    })

    it('handles large inputs with slicing', () => {
      const longText = 'word '.repeat(20000)
      // Implementation slices at 50,000 characters
      expect(countWords(longText)).toBeLessThan(20000)
    })
  });

  describe('md5', () => {
    it('generates correct MD5 hashes', () => {
      // Known hashes:
      // "" -> d41d8cd98f00b204e9800998ecf8427e
      // "hello" -> 5d41402abc4b2a76b9719d911017c592
      expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e')
      expect(md5('hello')).toBe('5d41402abc4b2a76b9719d911017c592')
      expect(md5('admin:password')).toBe('73eff6386ce2091b5ca702fc007e1da9')
    })
  });
})
