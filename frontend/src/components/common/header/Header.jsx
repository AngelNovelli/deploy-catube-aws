import logo from '../../../../public/catube_logo.png'
import { CatubeHeader } from './CatubeHeader.jsx'
import './CatubeHeader.css'
import { useTheme } from '../../../hooks/useTheme'
import logoDark from '../../../../public/catube_logo.png'

function Header({ searchQuery, setSearchQuery }) {
    const { isDarkMode } = useTheme();

    return (
        <CatubeHeader
            logo={isDarkMode ? logo : logoDark}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
        />
    )
}

export default Header