# Documentation Style Guide

This guide establishes standards for creating consistent, professional documentation across all planning documents.

## 1. Document Structure

### 1.1 Document Header Format
All documents must follow this exact header structure:

```markdown
# Document Title

> **Navigation:** [Home](00-documentation_index.md) | Previous: [Previous Doc](previous-doc.md) | Next: [Next Doc](next-doc.md)
>
> **Prerequisites:** Complete [Required Doc](required-doc.md) or brief description
>
> **Related Documents:**
> - [Related Doc 1](related-doc-1.md) - Brief description of relationship
> - [Related Doc 2](related-doc-2.md) - Brief description of relationship

---
```

### 1.2 Title Conventions
- Use descriptive, actionable titles
- Follow format: "Topic Planning" or "Topic Strategy"
- Avoid generic titles like "Planning Document"

### 1.3 Navigation Standards
- Always include Home link
- Include Previous/Next links when applicable
- Use relative paths without `./` prefix
- Format: `[Link Text](filename.md)`

### 1.4 Prerequisites Section
- Always include prerequisites
- Use either:
  - Link to required document: `Complete [Doc Name](doc.md)`
  - Brief description: `High-level business objectives defined`

### 1.5 Related Documents
- List 2-4 most relevant related documents
- Include brief description of relationship
- Use consistent bullet formatting

## 2. Content Organization

### 2.1 Section Hierarchy
- Use numbered main sections (## 1. Section Name)
- Use numbered subsections (### 1.1 Subsection Name)
- Avoid unnumbered sections after numbered ones
- Maximum 3 levels deep

### 2.2 Section Content
- Start each section with a brief introductory paragraph
- Use bullet points for lists of items
- Use numbered lists for sequential steps
- Include actionable prompts or questions where appropriate

### 2.3 Checklists and Prompts
- Use `[ ]` for uncompleted checklist items
- Use `[Prompt]` for areas requiring user input
- Use consistent formatting for interactive elements

## 3. Markdown Formatting Standards

### 3.1 Headings
- H1 (#): Document title only
- H2 (##): Main sections (numbered)
- H3 (###): Subsections (numbered)
- H4 (####): Sub-subsections (rarely used)
- No H5 or H6 headings

### 3.2 Lists
- Use hyphens (-) for unordered lists
- Use numbers (1., 2., 3.) for ordered lists
- Consistent indentation (2 spaces per level)
- No mixing of - and * within same document

### 3.3 Code and Code Blocks
- Use backticks (`) for inline code
- Use triple backticks (```) for code blocks
- Specify language for syntax highlighting when applicable
- Format: ```language

### 3.4 Links and References
- Use relative paths for internal links
- Format: `[Link Text](filename.md)`
- Include descriptive link text
- Avoid bare URLs

### 3.5 Emphasis and Formatting
- Use **bold** for emphasis and UI elements
- Use *italics* for emphasis (sparingly)
- Use `code` for technical terms, commands, file names
- Avoid underline formatting

### 3.6 Blockquotes
- Use > for navigation and metadata blocks only
- Use --- for section separators
- Avoid blockquotes for regular content

## 4. Terminology and Language

### 4.1 Consistent Terminology
- Use "Planning" for documents that establish strategy
- Use "Guide" for documents that provide how-to instructions
- Use "Checklist" for validation documents

### 4.2 Voice and Tone
- Use active voice when possible
- Write in present tense for procedures
- Use inclusive, professional language
- Be concise and actionable

### 4.3 Abbreviations and Acronyms
- Spell out acronyms on first use
- Use consistent capitalization (e.g., "API", not "api")
- Common acronyms don't need expansion: URL, HTTP, SQL, etc.

## 5. File Organization and Naming

### 5.1 File Naming
- Use lowercase with hyphens: `document-name.md`
- Follow pattern: `number-topic_name.md`
- Maintain sequential numbering

### 5.2 Document Relationships
- Ensure logical flow between documents
- Update navigation links when document order changes
- Maintain bidirectional links (Previous/Next)

## 6. Quality Standards

### 6.1 Completeness
- Every document must have all required sections
- Include examples where helpful
- Provide actionable next steps

### 6.2 Accuracy
- Verify all links work
- Ensure technical accuracy
- Update references when documents change

### 6.3 Maintenance
- Review and update documents quarterly
- Mark outdated content clearly
- Maintain change history in git

## 7. Tooling and Automation

### 7.1 Markdown Linting
- Use markdownlint for consistency checking
- Configure rules in `.markdownlint.json`
- Run linting in CI/CD pipeline

### 7.2 Link Validation
- Use link checker to validate internal references
- Fix broken links immediately
- Prevent merging with broken links

### 7.3 Formatting Tools
- Consider Prettier for markdown formatting
- Configure consistent line breaks and spacing
- Automate formatting in pre-commit hooks

## 8. Implementation Checklist

Use this checklist when creating or updating documents:

- [ ] Document follows header format exactly
- [ ] Navigation links are correct and working
- [ ] Prerequisites are clearly defined
- [ ] Related documents listed with descriptions
- [ ] Section hierarchy uses consistent numbering
- [ ] Markdown formatting follows standards
- [ ] Terminology is consistent with other docs
- [ ] All links use relative paths
- [ ] Document passes markdown linting
- [ ] Content is complete and actionable
- [ ] File naming follows conventions